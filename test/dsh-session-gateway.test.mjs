import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDshGateway } from '../scripts/dsh-session-gateway.mjs'

const start=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)))
const stop=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()})
test('dsh 网关先校验统一身份，凭据不下发浏览器，不信任伪造转发头',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'tuanzi-dsh-test-')),file=join(directory,'token')
 await writeFile(file,'a'.repeat(43))
 let status=200,upstreamCalls=0,bootstraps=0
 const auth=http.createServer((req,res)=>{assert.equal(req.url,'/api/auth/dsh-access');assert.equal(req.headers.cookie,'__Host-tuanzi_session=fixture');res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({userId:'fixture'}))})
 const dsh=http.createServer((req,res)=>{
  upstreamCalls++
  assert.equal(req.headers.host,'example.test')
  if(req.url.startsWith('/?token=')){bootstraps++;res.writeHead(303,{'Set-Cookie':'dsh-auth-fixture=trusted; Max-Age=3600; Path=/; HttpOnly',Location:'./'});res.end();return}
  assert.equal(req.headers.cookie,'dsh-auth-fixture=trusted')
  assert.equal(req.headers.authorization,undefined)
  assert.equal(req.headers['x-user-id'],undefined)
  res.writeHead(200,{'Set-Cookie':'dsh-auth-fixture=must-not-leak','Content-Type':'text/plain'});res.end('dsh content')
 })
 const authPort=await start(auth),dshPort=await start(dsh)
 const gateway=createDshGateway({origin:'https://example.test',authority:'example.test',authPort,dshPort,tokenFile:file,checkInterval:50})
 const port=await start(gateway),url=`http://127.0.0.1:${port}/`
 try{
  assert.equal((await fetch(url,{redirect:'manual'})).status,401);assert.equal(upstreamCalls,0)
  status=403;assert.equal((await fetch(url,{headers:{cookie:'__Host-tuanzi_session=fixture'}})).status,403);assert.equal(upstreamCalls,0)
  status=200
  const response=await fetch(url,{headers:{cookie:'__Host-tuanzi_session=fixture; other=private',authorization:'Bearer forged','x-user-id':'admin'}})
  assert.equal(response.status,200);assert.equal(await response.text(),'dsh content');assert.equal(response.headers.get('set-cookie'),null);assert.equal(bootstraps,1)
  const denied=await fetch(url,{method:'POST',headers:{cookie:'__Host-tuanzi_session=fixture',origin:'https://evil.test'},body:'unsafe'})
  assert.equal(denied.status,403);assert.equal(bootstraps,1)
  await writeFile(file,'b'.repeat(43))
  assert.equal((await fetch(url,{headers:{cookie:'__Host-tuanzi_session=fixture'}})).status,200);assert.equal(bootstraps,2)
 }finally{await stop(gateway);await stop(auth);await stop(dsh);await rm(directory,{recursive:true})}
})
