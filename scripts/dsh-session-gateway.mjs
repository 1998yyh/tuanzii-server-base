// 固定回环上游的 dsh 适配器。统一会话只交给账号后端，dsh 凭据只保留在服务端内存。
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const HOP = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','set-cookie'])
function response(res, status, message) {
  const body=JSON.stringify({message})
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':Buffer.byteLength(body)})
  res.end(body)
}
function headersOf(req, cookie, authority, websocket=false) {
  const headers={}
  for (const [key,value] of Object.entries(req.headers)) {
    if (!HOP.has(key) && !['cookie','authorization','host','origin'].includes(key) && !key.startsWith('x-') && key!=='sec-fetch-site' && value!==undefined)headers[key]=value
  }
  headers.host=authority;headers.cookie=cookie
  if(req.headers.origin || websocket)headers.origin=`http://${authority}`
  headers['sec-fetch-site']='same-origin'
  if(websocket){headers.connection='Upgrade';headers.upgrade='websocket'}
  return headers
}

export function createDshGateway({origin,authPort=3000,dshPort=3080,authority,tokenFile,checkInterval=30_000}) {
  const parsed=new URL(origin)
  if(parsed.origin!==origin || (parsed.protocol!=='https:' && !['127.0.0.1','localhost'].includes(parsed.hostname)))throw new Error('网关来源必须为 HTTPS，HTTP 只允许本机测试')
  if(!authority || /[\s/\\@]/.test(authority))throw new Error('上游 authority 无效')
  let cached,booting
  async function check(req) {
    const token=(req.headers.cookie??'').split(';').map(p=>p.trim()).filter(p=>/^__Host-tuanzi_session=/.test(p))
    if(token.length!==1)throw Object.assign(new Error('请通过统一入口登录'),{status:401})
    const result=await fetch(`http://127.0.0.1:${authPort}/api/auth/dsh-access`,{headers:{cookie:token[0],origin},signal:AbortSignal.timeout(5000),redirect:'error'})
    if(!result.ok)throw Object.assign(new Error(result.status===403?'此账号没有 dsh 访问权限':result.status===401?'请通过统一入口登录':'暂时无法验证登录状态'),{status:[401,403].includes(result.status)?result.status:503})
    return await result.json()
  }
  function source(req) {
    if(!req.url?.startsWith('/') || req.url.startsWith('//'))throw Object.assign(new Error('无效路径'),{status:400})
    const navigate=req.method==='GET' && req.url==='/' && req.headers['sec-fetch-mode']==='navigate'
    if(req.headers.origin && req.headers.origin!==origin)throw Object.assign(new Error('请求来源不受信任'),{status:403})
    if(req.headers['sec-fetch-site']==='cross-site' && !navigate)throw Object.assign(new Error('不接受跨站请求'),{status:403})
    if(!['GET','HEAD'].includes(req.method) && req.headers.origin!==origin)throw Object.assign(new Error('写操作必须来自本站'),{status:403})
  }
  async function credential() {
    const token=(await readFile(tokenFile,'utf8')).trim()
    if(!/^[A-Za-z0-9_-]{20,256}$/.test(token))throw new Error('dsh 尚未准备好')
    if(cached?.token===token && cached.until>Date.now())return cached.cookie
    if(booting?.token===token)return booting.promise
    const promise=(async()=>{
      // Node fetch 对 Host 的处理随运行时不同；使用原生 HTTP 明确设置 Cookie 的 authority。
      const reply=await new Promise((resolve,reject)=>{
        const request=http.get({host:'127.0.0.1',port:dshPort,path:`/?token=${encodeURIComponent(token)}`,headers:{host:authority}},response=>{response.resume();resolve({status:response.statusCode,cookies:response.headers['set-cookie']??[]})})
        request.setTimeout(5000,()=>request.destroy(new Error('dsh 认证交接超时')));request.once('error',reject)
      })
      const raw=reply.cookies.find(value=>value.startsWith('dsh-auth-'))
      if(reply.status!==303 || !raw)throw new Error('dsh 认证交接暂不可用')
      const age=Number(raw.match(/Max-Age=(\d+)/i)?.[1]??60)
      cached={token,cookie:raw.split(';')[0],until:Date.now()+Math.max(1,age-30)*1000}
      return cached.cookie
    })()
    booting={token,promise}
    try{return await promise}finally{if(booting?.promise===promise)booting=undefined}
  }
  function monitor(req,close) {
    const timer=setInterval(()=>{void check(req).catch(close)},checkInterval)
    timer.unref();return ()=>clearInterval(timer)
  }
  const server=http.createServer(async(req,res)=>{
    let upstream,stop=()=>{}
    try {
      source(req);await check(req)
      const cookie=await credential()
      upstream=http.request({host:'127.0.0.1',port:dshPort,path:req.url,method:req.method,headers:headersOf(req,cookie,authority)},reply=>{
        if(reply.statusCode===401)cached=undefined
        const headers={}
        for(const [key,value] of Object.entries(reply.headers))if(!HOP.has(key)&&value!==undefined)headers[key]=value
        res.writeHead(reply.statusCode??502,headers);reply.pipe(res)
      })
      upstream.on('error',()=>{if(!res.headersSent)response(res,503,'dsh 暂时不可用，请稍后重试');else res.destroy()})
      stop=monitor(req,()=>{upstream.destroy();res.destroy()})
      req.once('aborted',()=>upstream.destroy())
      res.once('close',()=>{stop();if(!res.writableFinished)upstream.destroy()});res.once('finish',stop)
      req.pipe(upstream)
    }catch(error){
      stop()
      const status=error.status??503
      if(status===401 && req.method==='GET' && req.url==='/' && (req.headers.accept??'').includes('text/html')){
        res.writeHead(303,{Location:'/login?returnTo=%2Fdsh%2F','Cache-Control':'no-store'});res.end()
      }else response(res,status,[401,403,400].includes(status)?error.message:'dsh 认证服务暂不可用，请稍后重试')
    }
  })
  server.on('upgrade',async(req,socket,head)=>{
    try {
      source(req)
      if(req.headers.origin!==origin)throw Object.assign(new Error('连接来源不受信任'),{status:403})
      await check(req);const cookie=await credential()
      const upstream=http.request({host:'127.0.0.1',port:dshPort,path:req.url,method:'GET',headers:headersOf(req,cookie,authority,true)})
      upstream.on('upgrade',(reply,peer,peerHead)=>{
        const rows=['HTTP/1.1 101 Switching Protocols']
        for(const [key,value] of Object.entries(reply.headers))if(key!=='set-cookie' && value!==undefined)rows.push(`${key}: ${Array.isArray(value)?value.join(', '):value}`)
        socket.write(rows.join('\r\n')+'\r\n\r\n');if(peerHead.length)socket.write(peerHead);if(head.length)peer.write(head)
        const stop=monitor(req,()=>{socket.destroy();peer.destroy()})
        const close=()=>{stop();socket.destroy();peer.destroy()}
        socket.once('close',close);peer.once('close',close);socket.once('error',close);peer.once('error',close)
        socket.pipe(peer);peer.pipe(socket)
      })
      upstream.once('response',reply=>{reply.resume();socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')})
      upstream.once('error',()=>socket.destroy());upstream.end()
    }catch(error){socket.end(`HTTP/1.1 ${[401,403].includes(error.status)?error.status:503} Access Denied\r\nConnection: close\r\n\r\n`)}
  })
  return server
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const server=createDshGateway({origin:process.env.AUTH_ORIGIN,authority:process.env.DSH_UPSTREAM_AUTHORITY,tokenFile:process.env.DSH_TOKEN_FILE??'/run/dsh-whale-auth/launch-token'})
  server.listen(Number(process.env.DSH_GATEWAY_PORT??3081),'127.0.0.1',()=>console.log('dsh 统一登录网关已监听本机'))
}
