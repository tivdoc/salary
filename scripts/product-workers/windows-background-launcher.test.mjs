import {expect,it} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {backgroundLauncherBytes,ensureBackgroundLauncher} from './windows-background-launcher.mjs';
it('uses a windowless GUI parent, waits for completion and returns the actual exit code',()=>{
 const b=backgroundLauncherBytes('C:\\private folder\\מקור\\task.ps1'),text=b.subarray(2).toString('utf16le');
 expect([...b.subarray(0,2)]).toEqual([255,254]);expect(text).toContain('shell.Run(command, 0, True)');
 expect(text).toContain('WScript.Quit result');expect(text).toContain('task.ps1.launch.log');expect(text).toContain('C:\\private folder\\מקור\\task.ps1');
});
it.each(['relative.ps1','C:\\bad%TEMP%.ps1','C:\\bad".ps1','C:\\bad\n.ps1','C:\\task.cmd'])('refuses command/path interpolation: %s',p=>{
 expect(()=>backgroundLauncherBytes(p)).toThrow('DEV_BACKGROUND_LAUNCHER_PATH');
});
it.skipIf(process.platform!=='win32')('preserves nonzero exit and append-only launch logs on two real GUI-host starts',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'tivdoc-hidden-task-')),ps=path.join(dir,'exit-code.ps1');
 try{
  writeFileSync(ps,'exit 7\r\n');const vbs=ensureBackgroundLauncher(ps),before=readFileSync(vbs);
  expect(ensureBackgroundLauncher(ps)).toBe(vbs);expect(readFileSync(vbs)).toEqual(before);
  for(let i=0;i<2;i++)expect(spawnSync(path.join(process.env.SystemRoot,'System32','wscript.exe'),['//B','//NoLogo',vbs],{windowsHide:true,timeout:10000}).status).toBe(7);
  const lines=readFileSync(ps+'.launch.log').toString('utf16le').replace(/^\uFEFF/u,'').trim().split(/\r?\n/u);
  expect(lines).toHaveLength(2);expect(lines.every(line=>line.endsWith('\t7'))).toBe(true);
  writeFileSync(vbs,'changed');expect(()=>ensureBackgroundLauncher(ps)).toThrow('DEV_BACKGROUND_LAUNCHER_CHANGED');
 }finally{
  if(path.dirname(path.resolve(dir))!==path.resolve(tmpdir())||!path.basename(dir).startsWith('tivdoc-hidden-task-'))throw Error('TEST_CLEANUP_SCOPE');
  rmSync(dir,{recursive:true,force:true});
 }
});
