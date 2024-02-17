
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

	subscriptions.push(vscode.commands.registerCommand('janim-toolbox.reset', async () => {
		port = -1;
		ensurePortAvailable();
	}))

	subscriptions.push(vscode.commands.registerCommand('janim-toolbox.reload', async () => {
		if (!await ensurePortAvailable()) {
			return;
		}

		socket.send(JSON.stringify({
			janim: {
				type: 'reload'
			}
		}), port);
		vscode.window.setStatusBarMessage('已执行: reload', 1000)
	}));
}

// export function deactivate() {}
