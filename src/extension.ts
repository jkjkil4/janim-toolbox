
import * as vscode from 'vscode';
import * as dgram from 'dgram';
import * as path from 'path';

class FoundClient {
	constructor(public port: number, public filePath: string) {}
}

export function activate({ subscriptions }: vscode.ExtensionContext) {
	// ========= VSC Window =========
	// 
	// 创建状态栏项，用于显示连接状态
	// 
	// 使用 hintDecoType 来高亮当前动画所在的行数
	// 其中 textChanged 用于控制在文本被修改后，不再高亮行数，需要重新构建后才会继续高亮
	// 
	// highlighting 用于记录上次的高亮行数，保证传入 highlightLine 的行数相同时，不重复触发编辑器行数跳转

	let statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	subscriptions.push(statusBarItem);
	statusBarItem.show();

	let textChanged = false;
	const hintDecoType = vscode.window.createTextEditorDecorationType({
		backgroundColor: { id: 'janim_toolbox.lineno_background' }
	});

	let highlighting = -1;
	let autoLocate = true;

	function highlightLine(line: number, disable_reveal: boolean = false) {
		// 使用 -1 表示不高亮，-2 表示是由文本保存导致的不高亮
		for (const editor of activeEditors) {
			if (line === -1 || line === -2) {
				editor.setDecorations(hintDecoType, []);
			} else {
				editor.setDecorations(hintDecoType, [{
					range: new vscode.Range(
						new vscode.Position(line, 0),
						new vscode.Position(line + 1, 0)
					),
					hoverMessage: '执行到的位置'
				}]);
			}
		}
		if (!disable_reveal) {
			// 判断 highlighting !== -2 ，表示如果这次高亮是跟在文本保存后面的，那么就不需要跳转行数
			if (autoLocate && activeEditors.length !== 0 && line !== -1 && line !== -2 && highlighting !== -2) {
				revealLine(activeEditors[0], line);
			}
		}
		highlighting = line;
	}

	function hideDecorations() {
		for (const editor of activeEditors) {
			editor.setDecorations(hintDecoType, []);
		}
	}

	function revealLine(editor: vscode.TextEditor, line: number) {
		const pos = new vscode.Position(line, 0);
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
	}

	// =========== Active Editor =========

	let activeEditors: vscode.TextEditor[] = [];

	function updateActiveEditors(editors: readonly vscode.TextEditor[] | undefined = undefined) {
		activeEditors = [];
		if (!client) {
			return;
		}
		if (editors === undefined) {
			editors = vscode.window.visibleTextEditors;
		}
		const filePath = path.resolve(client.filePath).toLowerCase();
		activeEditors = editors.filter(editor => {
			return filePath == path.resolve(editor.document.fileName).toLowerCase();
		});
		highlightLine(highlighting, true);
	}

	function getEditor(): vscode.TextEditor | undefined {
		if (activeEditors.length === 0) {
			return undefined;
		}
		return activeEditors[0];
	}

	subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(updateActiveEditors));

	// ========= Socket =========
	//
	// 创建 UDP Socket，用于与界面端进行通信

	let socket = dgram.createSocket('udp4');
	let client: FoundClient | undefined = undefined;
	let selectableClients: FoundClient[] = [];

	socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
		const json = JSON.parse(msg.toString());
		if (json.janim && json.janim.type) {
			const type = json.janim.type;
			switch (type) {
				case 'find_re': {
					selectableClients.push(new FoundClient(json.janim.data.port, json.janim.data.file_path));
					break;
				}

				case 'close_event': {
					highlightLine(-1);
					setClient(undefined);
					break;
				}

				case 'rebuilt': {
					textChanged = false;
					break;
				}

				case 'lineno': {
					if (textChanged) {
						break;
					}
					const lineno = json.janim.data - 1;
					highlightLine(lineno);
					break;
				}
			}
		}
	});

	function setClient(value: FoundClient | undefined) {
		client = value;
		if (client) {
			statusBarItem.text = `已连接至界面端 ${client.port}`;
		} else {
			textChanged = false;
			statusBarItem.text = '未连接至界面端';
		}
		updateActiveEditors();
	}

	async function ensurePortAvailable(): Promise<boolean> {
		if (client) {
			return true;
		}

		selectableClients = [];

		const config = vscode.workspace.getConfiguration('janim-toolbox');
		const clientSearchPort = config.get<number>('clientSearchPort');

		socket.send(JSON.stringify({
			janim: {
				type: 'find'
			}
		}), clientSearchPort, '127.0.0.1');

		await new Promise(resolve => setTimeout(resolve, 100));

		if (selectableClients.length === 0) {
			vscode.window.showErrorMessage('没有找到可用的界面端');
			return false;
		}

		let selectedClient: FoundClient | undefined = undefined;

		if (selectableClients.length === 1) {
			selectedClient = selectableClients[0];
		} else {
			let ports = selectableClients.map(port => {
				return {label: port.port.toString(), value: port};
			});

			let ret = await vscode.window.showQuickPick(ports, { title: '存在多个界面端，请选择端口：' });
			if (ret) {
				selectedClient = ret.value;
			}
		}

		if (selectedClient) {
			socket.send(JSON.stringify({
				janim: {
					type: 'register_client'
				}
			}), selectedClient.port);
			setClient(selectedClient);
			return true;
		}

		return false;
	}

	// ==========================

	subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
		// 由于在保存时会触发 0 变化的文字更改事件，所以这里过滤
		if (event.contentChanges.length === 0 || vscode.window.activeTextEditor?.document.uri !== getEditor()?.document.uri) {
			return;
		}

		textChanged = true;
		hideDecorations();
	}));

	subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
		if (!client || document.uri !== getEditor()?.document.uri) {
			return;
		}
		highlightLine(-2);
		socket.send(JSON.stringify({
			janim: {
				type: 'file_saved',
				file_path: document.fileName
			}
		}), client.port);
	}));

	subscriptions.push(vscode.commands.registerCommand('janim-toolbox.connect', async () => {
		setClient(undefined);
		await ensurePortAvailable();
	}));

	subscriptions.push(vscode.commands.registerCommand('janim-toolbox.locate-line', async () => {
		const editor = getEditor();
		if (editor && highlighting !== -1) {
			revealLine(editor, highlighting);
		}
	}));

	subscriptions.push(vscode.commands.registerCommand('janim-toolbox.switch-auto-locate', async () => {
		autoLocate = !autoLocate;
		if (autoLocate) {
			vscode.window.setStatusBarMessage('自动定位已开启', 1000);
		} else {
			vscode.window.setStatusBarMessage('自动定位已关闭', 1000);
		}
	}));
}

// export function deactivate() {}
