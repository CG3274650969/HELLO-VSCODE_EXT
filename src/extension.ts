import * as vscode from 'vscode';
import { NEW_CHAT_COMMAND, VIEW_ID } from './protocol';
import { ChatViewProvider } from './chatViewProvider';

// VS Code 加载插件后，会先调用 activate()。
// 你的所有注册（命令、监听器、视图…）都要放在这里，并 push 进 context.subscriptions。
export function activate(context: vscode.ExtensionContext) {
  console.log('Hello 插件已激活 🎉');

  // ---- 侧边栏聊天（Hello Chat） ----
  const chatProvider = new ChatViewProvider(
    context.extensionUri,
    context.globalStorageUri.fsPath, // 历史会话持久化目录（含 dsh-sessions/ 子目录）
    context.globalState, // 记住上次用的顶部模式（chat / harness）与后端来源（mock / live）
    context.secrets // live 后端从密钥库取 DEEPSEEK_API_KEY（无则回退读 credentialsFile）
  );
  const registerChatView = vscode.window.registerWebviewViewProvider(VIEW_ID, chatProvider, {
    // 不保留隐藏 webview 的上下文：折叠后内容销毁，靠扩展侧 snapshot 重建（省内存）
    webviewOptions: { retainContextWhenHidden: false },
  });
  const newChat = vscode.commands.registerCommand(NEW_CHAT_COMMAND, () => {
    chatProvider.startNewSession();
  });
  context.subscriptions.push(registerChatView, newChat, chatProvider);

  // ---- 命令 1：弹一个招呼 ----
  const sayHello = vscode.commands.registerCommand('hello.sayHello', () => {
    vscode.window.showInformationMessage('你好，我是你的第一个 VS Code 插件！');
  });

  // 命令 2：读取当前激活文件的第 1 行并展示
  const readActiveFile = vscode.commands.registerCommand('hello.readActiveFile', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('请先打开一个文件再运行此命令');
      return;
    }
    const doc = editor.document;
    const firstLine = doc.lineAt(0).text;
    const fileName = doc.fileName.split(/[\\/]/).pop();
    vscode.window.showInformationMessage(`当前文件「${fileName}」第 1 行是：${firstLine}`);
  });

  // 把注册结果交给 context.subscriptions 统一管理，插件卸载时会自动清理
  context.subscriptions.push(sayHello, readActiveFile);
}

// 插件卸载前调用，一般留空即可
export function deactivate() {}
