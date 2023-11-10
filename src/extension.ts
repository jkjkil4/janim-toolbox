
import * as vscode from 'vscode';
import * as dgram from 'dgram';

export function activate({ subscriptions }: vscode.ExtensionContext) {
	let statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	subscriptions.push(statusBarItem);

	function updateStatusBarItem() {
		const last = lastExecuted();
		if (last === -1) {
			statusBarItem.hide();
		} else {
			statusBarItem.text = `当前执行到第 ${last + 1} 行`;
			statusBarItem.show();
		}
	}

	let port = -1;
	let socket: dgram.Socket | undefined = undefined;

	async function ensurePortAvailable(): Promise<boolean> {
		if (port === -1) {
			await vscode.commands.executeCommand('janim-toolbox.set-port');
		}
		return port !== -1;
	}

	function sendUndo() {
		if (!socket) {
			return;
		}

		socket.send(JSON.stringify({
			janim: {
				type: 'undo_code'
			}
		}), port);
	}

	let executed: Array<number> = [];
	
	function isExecutedEmpty(): boolean {
		return executed.length === 0;
	}
	function addExecuted(lastLineNumber: number) {
		executed.push(lastLineNumber);
		updateStatusBarItem();
	}
	function undoExecuted() {
		if (isExecutedEmpty()) {
			return;
		}
		executed.pop();
		updateStatusBarItem();
	}
	function lastExecuted(): number {
		if (isExecutedEmpty()) {
			return -1;
		}
		return executed[executed.length - 1];
	}
	function clearExecuted() {
		executed = [];
		updateStatusBarItem();
	}

	subscriptions.push(vscode.commands.registerCommand('janim-toolbox.reset', async () => {
		port = -1;
		clearExecuted();
		vscode.window.showInformationMessage('已重置状态（注意：该操作未撤销先前执行过的代码）');
	}));

	subscriptions.push(vscode.commands.registerCommand('janim-toolbox.set-port', async () => {
		const ret = await vscode.window.showInputBox({title: '输入调试端口：'});
		if (!ret || ret.length === 0) {
			return;
		}
		port = Number(ret);
		if (!socket) {
			socket = dgram.createSocket('udp4');
		}
	}));

	subscriptions.push(vscode.commands.registerCommand('janim-toolbox.execute-code', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!await ensurePortAvailable() || !socket || !editor) {
			return;
		}
		
		// 得到用户选择的代码区域
		const selection = editor.selection;
		const start = selection.start;
		const end = selection.end;

		let text: string;

		// 如果区域的起始和终止相同
		// 则提取直至光标所在行的代码
		// 否则执行选中的区间内的代码
		if (start.isEqual(end)) {
			// 如果 executedLastLine 为空，表示先前没有进行过执行
			// 则向前获取所有缩进相同的部分
			// 否则向前获取至 executedLastLine[0] 为止
			if (isExecutedEmpty()) {
				const lastLine = editor.document.lineAt(end.line);

				// 得到缩进相同（或缩进更多）部分的首行
				const indent = lastLine.firstNonWhitespaceCharacterIndex;
				let startLineNumber = end.line;
				for (let i = end.line - 1; i >= 0; i--) {
					const line = editor.document.lineAt(i);
					if (!line.isEmptyOrWhitespace && line.firstNonWhitespaceCharacterIndex < indent) {
						break;
					}
					startLineNumber = i;
				}
				
				text = editor.document.getText(
					new vscode.Range(
						new vscode.Position(startLineNumber, 0),
						new vscode.Position(end.line + 1, 0)
					)
				);
			} else {
				// 如果当前光标位置在执行过的代码的前面，则忽略这次操作
				if (lastExecuted() >= end.line) {
					return;
				}

				text = editor.document.getText(
					new vscode.Range(
						new vscode.Position(lastExecuted() + 1, 0),
						new vscode.Position(end.line + 1, 0)
					)
				);
			}
			addExecuted(end.line);
		} else {
			for (let i = 0; i < executed.length; i++) {
				sendUndo();
			}
			clearExecuted();

			// 对区间进行扩展使其覆盖整行
			const lastLine = editor.document.lineAt(end.line);
			let adjustedEnd: vscode.Position;
			if (lastLine.firstNonWhitespaceCharacterIndex < end.character) {
				adjustedEnd = new vscode.Position(end.line + 1, 0);
			} else {
				adjustedEnd = new vscode.Position(end.line, 0);
			}

			// 数据设置
			text = editor.document.getText(
				new vscode.Range(
					new vscode.Position(start.line, 0),
					adjustedEnd
				)
			);
			addExecuted(end.line);
		}

		// 向调试端发送文本
		socket.send(JSON.stringify({
			janim: {
				type: 'exec_code',
				data: text
			}
		}), port);
	}));

	subscriptions.push(vscode.commands.registerCommand('janim-toolbox.undo-code', async () => {
		if (!await ensurePortAvailable() || !socket) {
			return;
		}
		undoExecuted();
		sendUndo();
	}));

	subscriptions.push(vscode.workspace.onDidChangeTextDocument(
		(event: vscode.TextDocumentChangeEvent) => {
			const document = event.document;
			const changes = event.contentChanges;

			changes.forEach(change => {
				const start = change.range.start;
				const end = change.range.end;
				const line = document.lineAt(start.line);

				for (let i = executed.length - 1; i >= 0; i--) {
					// 如果修改位置在已执行到位置的后面，则结束处理
					if (executed[i] < start.line) {
						break;
					}

					// 对仅换行的情况进行忽略
					if (start.isEqual(end) && start.line === executed[i] && start.character === line.text.length) {
						const endLineNumber = (
							line.text.length === end.character
							? end.line + 1
							: end.line
						);
						if (document.lineAt(endLineNumber).isEmptyOrWhitespace) {
							continue;
						}
					}

					// 修改位置在已执行到位置处，或更前面，则撤销该步
					undoExecuted();
					sendUndo();
				}
			});
		}
	));

	subscriptions.push(vscode.commands.registerCommand('janim-toolbox.display-children-index', async () => {
		if (!await ensurePortAvailable() || !socket) {
			return;
		}
		
		const ret = await vscode.window.showInputBox({title: '输入要查看子物件序号的对象：'});
		if (!ret) {
			return;
		}

		socket.send(JSON.stringify({
			janim: {
				type: 'display_children_index',
				data: ret
			}
		}), port);
	}));
}

// export function deactivate() {}
