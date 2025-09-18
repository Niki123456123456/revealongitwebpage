import * as vscode from 'vscode';
import * as path from 'path';

type GitAPI = {
  getRepository(uri: vscode.Uri): any | undefined;
  repositories: any[];
};
type GitExtension = {
  getAPI(version: number): GitAPI;
};

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    'revealongitwebpage',
    async (resourceUri?: vscode.Uri) => {
      try {
        const uri =
          resourceUri ??
          vscode.window.activeTextEditor?.document.uri ??
          undefined;
        if (!uri) {
          vscode.window.showErrorMessage('No file selected.');
          return;
        }

        // Acquire Git API
        const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (!gitExt) {
          vscode.window.showErrorMessage('VS Code Git extension not found.');
          return;
        }
        const git = gitExt.isActive
          ? gitExt.exports.getAPI(1)
          : (await gitExt.activate(), gitExt.exports.getAPI(1));

        // Find the repository for the file
        const repo =
          git.getRepository(uri) ??
          git.repositories.find((r: any) => {
            const repoPath = r.rootUri.fsPath;
            return (
              uri.fsPath.startsWith(repoPath + path.sep) || uri.fsPath === repoPath
            );
          });
        if (!repo) {
          vscode.window.showErrorMessage('File is not inside a Git repository.');
          return;
        }

        // Current branch (fallback: short commit)
        const head = repo.state?.HEAD;
        const branchOrSha =
          (head?.name as string | undefined) ??
          (head?.commit ? String(head.commit).slice(0, 8) : undefined);
        if (!branchOrSha) {
          vscode.window.showErrorMessage('Could not determine current branch or commit.');
          return;
        }

        // Choose a remote (prefer origin)
        const remote =
          repo.state?.remotes?.find((r: any) => r.name === 'origin') ??
          repo.state?.remotes?.[0];
        const remoteUrl: string | undefined = remote?.pushUrl ?? remote?.fetchUrl;
        if (!remoteUrl) {
          vscode.window.showErrorMessage('No Git remote found for this repository.');
          return;
        }

        const httpBase = toHttpRemoteBase(remoteUrl);
        if (!httpBase) {
          vscode.window.showErrorMessage(`Could not normalize remote: ${remoteUrl}`);
          return;
        }

        const forge = detectForge(httpBase);
        if (forge === 'unknown') {
          vscode.window.showWarningMessage(
            `Unrecognized Git host for remote: ${remoteUrl}. Using GitHub-style URL.`
          );
        }

        // Repo-relative POSIX path for the file
        const relFsPath = path.relative(repo.rootUri.fsPath, uri.fsPath);
        const repoRelPath = relFsPath.split(path.sep).join('/'); // POSIX

        // Optional: if invoked from editor, include the caret line
        let caretLine: number | undefined;
        const active = vscode.window.activeTextEditor;
        if (active && active.document.uri.toString() === uri.toString()) {
          caretLine = active.selection.active.line + 1;
        }

        const url = buildBlobUrl(forge, httpBase, branchOrSha, repoRelPath, caretLine);

        await vscode.env.openExternal(vscode.Uri.parse(url));
      } catch (err: any) {
        console.error(err);
        vscode.window.showErrorMessage(`Reveal in remote failed: ${err?.message ?? err}`);
      }
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}

/**
 * Convert various Git remote URL formats to an HTTPS web base WITHOUT .git
 * Examples
 *  - https://gitlab.com/group/repo.git         -> https://gitlab.com/group/repo
 *  - git@gitlab.com:group/repo.git             -> https://gitlab.com/group/repo
 *  - ssh://git@gitlab.company.com:2222/group/repo.git -> https://gitlab.company.com/group/repo
 *  - https://github.com/owner/repo.git         -> https://github.com/owner/repo
 *  - git@github.com:owner/repo.git             -> https://github.com/owner/repo
 *  - ssh://git@github.company.com/owner/repo.git -> https://github.company.com/owner/repo
 */
function toHttpRemoteBase(remoteUrl: string): string | null {
  // HTTPS/HTTP
  if (remoteUrl.startsWith('http://') || remoteUrl.startsWith('https://')) {
    return remoteUrl.replace(/\.git$/, '');
  }

  // SCP-like SSH: git@host:group/subgroup/repo.git
  const scp = /^.+@([^:]+):(.+?)(?:\.git)?$/i.exec(remoteUrl);
  if (scp) {
    const host = scp[1];
    const pathPart = scp[2];
    return `https://${host}/${pathPart.replace(/\.git$/, '')}`;
  }

  // ssh://git@host[:port]/group/repo.git
  const ssh = /^ssh:\/\/.+@([^/]+)\/(.+?)(?:\.git)?$/i.exec(remoteUrl);
  if (ssh) {
    const host = ssh[1].replace(/:\d+$/, ''); // strip port, web usually on 443
    const pathPart = ssh[2];
    return `https://${host}/${pathPart.replace(/\.git$/, '')}`;
  }

  return null;
}

type Forge = 'gitlab' | 'github' | 'unknown';

function detectForge(httpBase: string): Forge {
  try {
    const host = new URL(httpBase).host.toLowerCase();
    if (host.includes('gitlab')) return 'gitlab';
    if (host.includes('github')) return 'github'; // works for github.com and GHE
  } catch {
    // ignore
  }
  return 'unknown';
}

/**
 * Build a view URL to a file for the supported forge.
 * - GitLab:   <base>/-/blob/<branchOrSha>/<path>#Lx
 * - GitHub:   <base>/blob/<branchOrSha>/<path>#Lx
 * For unknown hosts, we fall back to the GitHub style (often correct).
 */
function buildBlobUrl(
  forge: Forge,
  httpBase: string,
  branchOrSha: string,
  repoRelPath: string,
  caretLine?: number
): string {
  const encodedBranch = encodeURIComponent(branchOrSha);
  const encodedPath = repoRelPath.split('/').map(encodeURIComponent).join('/');
  const lineFrag = typeof caretLine === 'number' ? `#L${caretLine}` : '';

  switch (forge) {
    case 'gitlab':
      return `${httpBase}/-/blob/${encodedBranch}/${encodedPath}${lineFrag}`;
    case 'github':
      return `${httpBase}/blob/${encodedBranch}/${encodedPath}${lineFrag}`;
    default:
      // Sensible default
      return `${httpBase}/blob/${encodedBranch}/${encodedPath}${lineFrag}`;
  }
}
