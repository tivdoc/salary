import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** A GUI-subsystem parent prevents the console flash that occurs before
 * powershell.exe processes -WindowStyle Hidden. Waiting preserves task overlap
 * protection and the child exit code; the worker keeps its sanitized receipts. */
export function backgroundLauncherBytes(launcher){
 if(!path.win32.isAbsolute(launcher)||!launcher.endsWith('.ps1')||/["%\r\n\0]/u.test(launcher))throw Error('DEV_BACKGROUND_LAUNCHER_PATH');
 const literal=s=>'"'+s.replaceAll('"','""')+'"';
 const code=`Option Explicit\r\nDim shell, fs, log, result, command, started\r\nSet shell = CreateObject("WScript.Shell")\r\nSet fs = CreateObject("Scripting.FileSystemObject")\r\nstarted = Now\r\ncommand = Chr(34) & shell.ExpandEnvironmentStrings("%SystemRoot%") & "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" & Chr(34) & " -NoProfile -NonInteractive -WindowStyle Hidden -File " & Chr(34) & ${literal(launcher)} & Chr(34)\r\nOn Error Resume Next\r\nresult = shell.Run(command, 0, True)\r\nIf Err.Number <> 0 Then\r\n  result = 125\r\n  Err.Clear\r\nEnd If\r\nSet log = fs.OpenTextFile(${literal(launcher+'.launch.log')}, 8, True, -1)\r\nlog.WriteLine CStr(started) & vbTab & CStr(Now) & vbTab & CStr(result)\r\nlog.Close\r\nWScript.Quit result\r\n`;
 return Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(code,'utf16le')]);
}
export function ensureBackgroundLauncher(launcher){
 const file=launcher+'.vbs',bytes=backgroundLauncherBytes(launcher);
 if(existsSync(file)){if(!readFileSync(file).equals(bytes))throw Error('DEV_BACKGROUND_LAUNCHER_CHANGED');}
 else writeFileSync(file,bytes,{flag:'wx'});
 return file;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==3)throw Error('DEV_BACKGROUND_ARGUMENTS');
 console.log(ensureBackgroundLauncher(process.argv[2]));
}
