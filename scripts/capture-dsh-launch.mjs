// 由 dsh 服务用户运行：捕获启动凭据到私有运行目录，日志中不保留带 token 的启动 URL。
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
const file=process.env.DSH_TOKEN_FILE??'/run/dsh-whale-auth/launch-token'
mkdirSync(dirname(file),{recursive:true,mode:0o700})
try{unlinkSync(file)}catch(error){if(error.code!=='ENOENT')throw error}
const child=spawn(process.execPath,process.argv.slice(2),{stdio:['ignore','pipe','inherit']})
createInterface({input:child.stdout}).on('line',line=>{
  if(line.startsWith('dsh web: ')){
    const url=new URL(line.slice('dsh web: '.length)),token=url.searchParams.get('token')
    if(!token || !/^[\w-]{20,256}$/.test(token))throw new Error('dsh 启动凭据格式无效')
    writeFileSync(file+'.next',token,{mode:0o600});renameSync(file+'.next',file)
    console.log('dsh web: [启动凭据已交给统一登录网关]')
  }else console.log(line)
})
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal))
child.on('exit',(code)=>{try{unlinkSync(file)}catch{}process.exitCode=code??1})
