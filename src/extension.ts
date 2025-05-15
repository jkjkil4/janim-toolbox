
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

	let cachedEditor: vscode.TextEditor | undefined = undefined;

	function getEditor(): vscode.TextEditor | undefined {
		if (!client) {
			return undefined;
		}
		if (cachedEditor) {
			return cachedEditor;
		}
		const filePath = path.resolve(client.filePath).toLowerCase()
		for (let editor of vscode.window.visibleTextEditors) {
			if (filePath == path.resolve(editor.document.fileName).toLowerCase()) {
				cachedEditor = editor;
				return editor;
			}
		}
		return undefined;
	}

	let highlighting = -1;
	let autoLocate = true;

	function highlightLine(editor: vscode.TextEditor, line: number) {
		if (line === -1) {
			editor.setDecorations(hintDecoType, []);
		} else {
			editor.setDecorations(hintDecoType, [{
				range: new vscode.Range(
					new vscode.Position(line, 0),
					new vscode.Position(line + 1, 0)
				),
				hoverMessage: '执行到的位置'
			}]);
			if (autoLocate && line !== highlighting) {
				revealLine(editor, line);
			}
		}
		highlighting = line;
	}

	function revealLine(editor: vscode.TextEditor, line: number) {
		const pos = new vscode.Position(line, 0);
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
	}

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
					const editor = getEditor();
					if (editor) {
						highlightLine(editor, -1);
					}
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
					const editor = getEditor();
					if (editor) {
						highlightLine(editor, lineno);
					}
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
			cachedEditor = undefined;
			statusBarItem.text = '未连接至界面端';
		}
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
		if (event.contentChanges.length === 0 || vscode.window.activeTextEditor !== getEditor()) {
			return;
		}

		textChanged = true;
		const editor = getEditor();
		if (editor) {
			highlightLine(editor, -1);
		}
	}));

	subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
		if (!client) {
			return;
		}
		socket.send(JSON.stringify({
			janim: {
				type: 'file_saved',
				file_path: document.fileName
			}
		}), client.port);
	}));

	subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
		// 因为切换活动编辑器后，原有的 deco 会被清除，所以这里需要重新设置
		if (editor && editor.document.uri === getEditor()?.document.uri) {
			highlightLine(editor, highlighting);
		}
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
