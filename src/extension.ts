import * as vscode from 'vscode';
import { AssetHoverProvider } from './providers/assetHoverProvider';

const LANGUAGES = [
  'typescript', 'typescriptreact', 'javascript', 'javascriptreact',
  'vue', 'svelte', 'css', 'scss', 'less', 'html',
];

export function activate(context: vscode.ExtensionContext): void {
  const provider = new AssetHoverProvider();
  const selector: vscode.DocumentSelector = LANGUAGES.map((language) => ({ language, scheme: 'file' }));

  const configWatcher = vscode.workspace.createFileSystemWatcher('**/{tsconfig,jsconfig}*.json');
  const clearCaches = () => provider.resolver.clearCaches();

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, provider),
    configWatcher,
    configWatcher.onDidChange(clearCaches),
    configWatcher.onDidCreate(clearCaches),
    configWatcher.onDidDelete(clearCaches),
  );
}

export function deactivate(): void {
}
