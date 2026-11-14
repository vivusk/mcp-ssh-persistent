/**
 * PowerShell fallback for Windows Credential Manager (D2).
 * Used only when the @napi-rs/keyring native binary cannot load.
 * Spawns Windows PowerShell with an Add-Type P/Invoke of advapi32
 * CredReadW / CredWriteW / CredDeleteW (CRED_TYPE_GENERIC). The secret never
 * appears in argv: it is piped on child stdin (write) or read from stdout (read).
 * Blobs are UTF-16LE, same as @napi-rs/keyring, so both paths interoperate.
 */
import { spawn } from 'child_process';

const TIMEOUT_MS = 5000;
const EXIT_MISSING = 3;

// C# helper compiled by Add-Type. Read: 0 + secret on stdout, 3 = not found.
const CSHARP = `
using System; using System.Runtime.InteropServices; using System.Text;
public static class McpSshCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  const int NOT_FOUND = 1168;
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) {
      int e = Marshal.GetLastWin32Error();
      if (e == NOT_FOUND) return null;
      throw new System.ComponentModel.Win32Exception(e);
    }
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      return c.CredentialBlobSize == 0 ? "" : Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
    } finally { CredFree(p); }
  }
  public static void Write(string target, string user, string secret) {
    byte[] blob = Encoding.Unicode.GetBytes(secret);
    var c = new CREDENTIAL { Type = 1, TargetName = target, UserName = user, Persist = 2, CredentialBlobSize = blob.Length };
    c.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length);
      if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); Array.Clear(blob, 0, blob.Length); }
  }
  public static bool Delete(string target) {
    if (CredDeleteW(target, 1, 0)) return true;
    int e = Marshal.GetLastWin32Error();
    if (e == NOT_FOUND) return false;
    throw new System.ComponentModel.Win32Exception(e);
  }
}`;

/** Single-quoted PowerShell literal (targets are validated, this is defence in depth). */
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Build the PowerShell script for one operation; never contains the secret. */
function buildScript(op, target, user) {
  const body = {
    read: `$s = [McpSshCred]::Read(${psQuote(target)}); if ($null -eq $s) { exit ${EXIT_MISSING} }; [Console]::Out.Write($s)`,
    write: `$s = [Console]::In.ReadToEnd(); [McpSshCred]::Write(${psQuote(target)}, ${psQuote(user)}, $s)`,
    delete: `if (-not [McpSshCred]::Delete(${psQuote(target)})) { exit ${EXIT_MISSING} }`,
  }[op];
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    `Add-Type -TypeDefinition @'\n${CSHARP}\n'@`,
    body,
  ].join('\n');
}

/**
 * Run one credential operation in a child PowerShell.
 * @param {'read'|'write'|'delete'} op
 * @param {string} target - WCM target name
 * @param {string} user - WCM UserName attribute (write only)
 * @param {string} [stdinSecret] - Secret for write (piped on stdin)
 * @returns {Promise<{code:number, stdout:string}>}
 */
function runPowerShell(op, target, user, stdinSecret = '') {
  const encoded = Buffer.from(buildScript(op, target, user), 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Windows Credential Manager (PowerShell) ${op} timed out after ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || code === EXIT_MISSING) return resolve({ code, stdout: Buffer.concat(out).toString('utf8') });
      // stderr carries only the PowerShell error text, never the secret.
      const msg = Buffer.concat(err).toString('utf8').trim().split('\n')[0] || `exit ${code}`;
      reject(new Error(`Windows Credential Manager (PowerShell) ${op} failed: ${msg}`));
    });
    child.stdin.on('error', () => { /* child exited early; close handler reports */ });
    child.stdin.end(stdinSecret, 'utf8');
  });
}

/** @returns {Promise<string|null>} secret, or null when missing */
export async function psReadCredential(target) {
  const { code, stdout } = await runPowerShell('read', target, '');
  return code === EXIT_MISSING ? null : stdout;
}

/** Store a secret (overwrites). */
export async function psWriteCredential(target, user, secret) {
  await runPowerShell('write', target, user, secret);
}

/** @returns {Promise<boolean>} true when a credential was deleted */
export async function psDeleteCredential(target) {
  const { code } = await runPowerShell('delete', target, '');
  return code === 0;
}
