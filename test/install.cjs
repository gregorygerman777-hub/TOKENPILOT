const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {execFileSync,spawnSync}=require('node:child_process');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'tokenpilot-install-test-'));
const installer=path.resolve('scripts/install.sh');const archive=path.resolve('release/TokenPilot-1.2.1-arm64-mac.zip');
const prefix=path.join(tmp,'folder with spaces');
const run=(extra=[])=>execFileSync('/bin/sh',[installer,'--archive',archive,'--prefix',prefix,'--no-open',...extra],{encoding:'utf8'});
try{
 execFileSync('/bin/sh',['-n',installer]);
 const bad=path.join(tmp,'bad.zip');fs.writeFileSync(bad,'corrupted');
 const failure=spawnSync('/bin/sh',[installer,'--archive',bad,'--prefix',prefix,'--no-open'],{encoding:'utf8'});
 assert.notEqual(failure.status,0);assert.match(failure.stderr,/Checksum mismatch/);assert.equal(fs.existsSync(path.join(prefix,'Applications')),false);
 console.log(run());
 const cli=path.join(prefix,'.local/bin/tokenpilot');
 const status=JSON.parse(execFileSync(cli,['status'],{encoding:'utf8',env:{...process.env,TOKENPILOT_DATA:path.join(tmp,'data')}}));
 assert.equal(status.semgrep.available,true);assert.equal(status.gitleaks.available,true);
 const version=execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(prefix,'Applications/TokenPilot.app/Contents/Info.plist')],{encoding:'utf8'}).trim();assert.equal(version,'1.2.1');
 console.log(run());assert.ok(fs.readdirSync(path.join(prefix,'Applications')).some(n=>n.startsWith('TokenPilot.previous.')));
 fs.writeFileSync(cli,'#!/bin/sh\necho unrelated');
 const collision=spawnSync('/bin/sh',[installer,'--archive',archive,'--prefix',prefix,'--no-open'],{encoding:'utf8'});assert.notEqual(collision.status,0);assert.match(collision.stderr,/unrelated tokenpilot/);
 console.log('Installer: checksum failure, real installation, paths with spaces, bundled CLI status, safe upgrade and collision protection passed.');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
