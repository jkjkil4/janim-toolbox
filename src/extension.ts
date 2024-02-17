
import * as vscode from 'vscode';
import * as dgram from 'dgram';

export function activate({ subscriptions }: vscode.ExtensionContext) {
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
				case 'close_event': {
					port = -1;
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

			socket.send(JSON.stringify({
				janim: {
					type: 'listen_close_event'
				}
			}), port);
		}

		return port !== -1;
	}

	subscriptions.push(vscode.commands.registerCommand('janim-toolbox.connect', async () => {
		port = -1;
		ensurePortAvailable();
	}))

	subscriptions.push(vscode.workspace.onDidSaveTextDocument((document: vscode.TextDocument) => {
		if (port === -1) {
			return;
		}
		socket.send(JSON.stringify({
			janim: {
				type: 'file_saved',
				file_path: document.fileName
			}
		}), port);
	}));
}

// export function deactivate() {}
