
import * as vscode from 'vscode';
import * as dgram from 'dgram';
import * as path from 'path';

class FoundPort {
	constructor(public port: number, public filePath: string) {}
}

export function activate({ subscriptions }: vscode.ExtensionContext) {
	let statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	subscriptions.push(statusBarItem);
	statusBarItem.show();

	const hintDecoType = vscode.window.createTextEditorDecorationType({
		backgroundColor: { id: 'janim_toolbox.lineno_background' }
	});

	let port = new FoundPort(-1, '');
	let textChanged = false;
	let socket = dgram.createSocket('udp4');

	let selectablePorts: Array<FoundPort> = [];

	function setPort(value: FoundPort) {
		port = value;
		if (port.port === -1) {
			textChanged = false;
			statusBarItem.text = '未连接至界面端';
		} else {
			statusBarItem.text = `已连接至界面端 ${port.port}`;
		}
	}

	function getEditor(): vscode.TextEditor | undefined {
		const filePath = path.resolve(port.filePath).toLowerCase()
		for (let editor of vscode.window.visibleTextEditors) {
			if (filePath == path.resolve(editor.document.fileName).toLowerCase()) {
				return editor;
			}
		}
		return undefined;
	}

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
		}
	}

	socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
		const json = JSON.parse(msg.toString());
		if (json.janim && json.janim.type) {
			const type = json.janim.type;
			switch (type) {
				case 'find_re': {
					selectablePorts.push(new FoundPort(json.janim.data.port, json.janim.data.file_path));
					break;
				}

				case 'close_event': {
					const editor = getEditor();
					if (editor) {
						highlightLine(editor, -1);
					}
					setPort(new FoundPort(-1, ''));
					break;
				}

				case 'rebuilt': {
					textChanged = false;
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

	async function ensurePortAvailable(): Promise<boolean> {
		if (port.port !== -1) {
			return true;
		}

		selectablePorts = [];

		socket.send(JSON.stringify({
			janim: {
				type: 'find'
			}
		}), 40565, '127.255.255.255');

		await new Promise(resolve => setTimeout(resolve, 100));

		if (selectablePorts.length === 0) {
			vscode.window.showErrorMessage('没有找到可用的界面端');
			return false;
		}

		if (selectablePorts.length === 1) {
			setPort(selectablePorts[0]);
		} else {
			let ports = selectablePorts.map(port => {
				return {label: port.port.toString(), value: port};
			});

			let ret = await vscode.window.showQuickPick(ports, { title: '存在多个界面端，请选择端口：' });
			if (ret) {
				setPort(ret.value);
			}
		}

		if (port.port !== -1) {
			socket.send(JSON.stringify({
				janim: {
					type: 'register_client'
				}
			}), port.port);
		}

		return port.port !== -1;
	}

	subscriptions.push(vscode.commands.registerCommand('janim-toolbox.connect', async () => {
		setPort(new FoundPort(-1, ''));
		await ensurePortAvailable();
	}));

	subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
		textChanged = true;
		const editor = getEditor();
		if (editor) {
			highlightLine(editor, -1);
		}
	}));

	subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
		if (port.port === -1) {
			return;
		}
		socket.send(JSON.stringify({
			janim: {
				type: 'file_saved',
				file_path: document.fileName
			}
		}), port.port);
	}));

	subscriptions.push(vscode.commands.registerCommand('janim-toolbox.reload', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!await ensurePortAvailable() || !editor) {
			return;
		}
		socket.send(JSON.stringify({
			janim: {
				type: 'reload',
				file_path: editor.document.fileName
			}
		}), port.port);
	}));
}

// export function deactivate() {}
