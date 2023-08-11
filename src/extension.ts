
import * as vscode from 'vscode';
import * as dgram from 'dgram';

export function activate(context: vscode.ExtensionContext) {
	let port = -1;
	let socket: dgram.Socket | undefined = undefined;

	async function ensurePortAvailable(): Promise<boolean> {
		if (port === -1) {
			await vscode.commands.executeCommand('janim-toolbox.set-port');
		}
		return port !== -1;
	}

	vscode.commands.registerCommand('janim-toolbox.set-port', async () => {
		const ret = await vscode.window.showInputBox({title: '输入调试端口：'});
		if (!ret || ret.length === 0) {
			return;
		}
		port = Number(ret);
		if (!socket) {
			socket = dgram.createSocket('udp4');
		}
	});
	vscode.commands.registerCommand('janim-toolbox.execute-code', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!await ensurePortAvailable() || !socket || !editor) {
			return;
		}
		
		const selection = editor.selection;
		const lineMin = Math.min(selection.anchor.line, selection.active.line);
		const lineMax = Math.max(selection.anchor.line, selection.active.line);
		const text = editor.document.getText(
			new vscode.Range(
				new vscode.Position(lineMin, 0),
				new vscode.Position(lineMax + 1, 0)
			)
		);

		socket.send(JSON.stringify({
			janim: {
				type: 'exec_code',
				data: text
			}
		}), port);
	});
	vscode.commands.registerCommand('janim-toolbox.undo-code', async () => {
		if (!await ensurePortAvailable() || !socket) {
			return;
		}

		socket.send(JSON.stringify({
			janim: {
				type: 'undo_code'
			}
		}));
	});

	// context.subscriptions.push(disposable);
}

// export function deactivate() {}
