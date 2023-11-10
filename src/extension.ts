
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
	let socket = dgram.createSocket('udp4');

	let selectableClients: Array<number> = [];

	socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
		const json = JSON.parse(msg.toString());
		if (json.janim && json.janim.type) {
			const type = json.janim.type;
			switch (type) {
				case 'find_re': {
					const port = json.janim.data;
					if (port) {
						selectableClients.push(port);
					}
				}
			}
		}
	});

	async function ensurePortAvailable(): Promise<boolean> {
		if (port !== -1) {
			return true;
		}

		selectableClients = [];

		socket.send(JSON.stringify({ 
			janim: { 
				type: 'find' 
			} 
		}), 40565, '127.255.255.255');

		await new Promise(resolve => setTimeout(resolve, 100));

		if (selectableClients.length === 0) {
			vscode.window.showErrorMessage('没有找到可用的界面端');
			return false;
		}

		if (selectableClients.length === 1) {
			port = selectableClients[0];
		} else {
			let ports: Array<string> = [];
			selectableClients.forEach(port => {
				ports.push(port.toString());
			});

			let ret = await vscode.window.showQuickPick(ports, { title: '存在多个界面端，请选择端口：' });
			if (ret) {
				port = Number(ret);
			}
		}

		if (port !== -1) {
			vscode.window.setStatusBarMessage(`已连接至界面端 ${port}`, 3000);
		}

		return port !== -1;
	}

	function sendUndo() {
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
		updateDecos();
	}
	function undoExecuted() {
		if (isExecutedEmpty()) {
			return;
		}
		executed.pop();
		updateStatusBarItem();
		updateDecos();
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
		updateDecos();
	}

	subscriptions.push(vscode.commands.registerCommand('janim-toolbox.reset', async () => {
		port = -1;
		clearExecuted();
		vscode.window.setStatusBarMessage('已重置状态（注意：该操作未撤销先前执行过的代码）', 3000);
	}));

	subscriptions.push(vscode.commands.registerCommand('janim-toolbox.execute-code', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!await ensurePortAvailable() || !editor) {
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
		if (!await ensurePortAvailable()) {
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

	const hintDecoType = vscode.window.createTextEditorDecorationType({
		backgroundColor: { id: 'janim_toolbox.hint_background' }
	});

	function updateDecos() {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}

		if (isExecutedEmpty()) {
			editor.setDecorations(hintDecoType, []);
		} else {
			const lineNumber = lastExecuted();
			editor.setDecorations(hintDecoType, [{
				range: new vscode.Range(
					new vscode.Position(lineNumber, 0),
					new vscode.Position(lineNumber + 1, 0)
				),
				hoverMessage: '执行到的最后一行'
			}]);
		}
	}

	let prevDisplayedCIV = "";

	subscriptions.push(vscode.commands.registerCommand('janim-toolbox.display-children-index', async () => {
		if (!await ensurePortAvailable()) {
			return;
		}
		
		const ret = await vscode.window.showInputBox({title: '输入要查看子物件序号的对象（留空表示清除显示）：', value: prevDisplayedCIV });
		if (ret === undefined) {
			return;
		}
		if (ret.length !== 0) {
			prevDisplayedCIV = ret;
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
