import { getStore } from '@netlify/blobs';
import { randomBytes, timingSafeEqual, createHash, randomInt } from 'node:crypto';

const json = (statusCode, data) => ({ statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: JSON.stringify(data) });
const hash = v => createHash('sha256').update(v).digest('hex');
const equal = (a,b) => { const x=Buffer.from(String(a??'')), y=Buffer.from(String(b??'')); return x.length===y.length && timingSafeEqual(x,y); };
const token = () => randomBytes(32).toString('base64url');
const clean = (v,max) => String(v??'').trim().slice(0,max);
const store = () => getStore({ name: 'familia-2026-v2', consistency: 'strong' });
const authenticated = (b) => Boolean(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length>=12 && equal(b.password,process.env.ADMIN_PASSWORD));
const shuffle = (xs) => { let a=[...xs]; for(let i=a.length-1;i>0;i--){const j=randomInt(i+1);[a[i],a[j]]=[a[j],a[i]];} return a; };
function draw(people, exclusions) {
 const ids=people.map(p=>p.id), pairs=new Set(exclusions.map(([a,b])=>[a,b].sort().join('|')));
 const allowed=(a,b)=>a!==b&&!pairs.has([a,b].sort().join('|'));
 const degree=Object.fromEntries(ids.map(a=>[a,ids.filter(b=>allowed(a,b)).length]));
 if(Object.values(degree).some(n=>n===0))return null;
 const sources=[...ids].sort((a,b)=>degree[a]-degree[b]);
 let attempts=0;
 function search(i,used,assigned){ if(++attempts>200000)return false; if(i===sources.length)return {...assigned};
  const a=sources[i], opts=shuffle(ids.filter(b=>!used.has(b)&&allowed(a,b)));
  for(const b of opts){used.add(b);assigned[a]=b;const result=search(i+1,used,assigned);if(result)return result;used.delete(b);delete assigned[a];}return false;
 }
 return search(0,new Set(),{});
}
export async function handler(event) {
 if(event.httpMethod!=='POST')return json(405,{error:'Método no permitido'});
 if((event.body||'').length>100000)return json(413,{error:'Solicitud demasiado grande'});
 let b;try{b=JSON.parse(event.body||'{}');}catch{return json(400,{error:'Datos inválidos'});}
 const action=b.action;
 try {
  const s=store();
  if(action==='admin-status'||action==='admin-create'||action==='admin-wishes') {
   if(!authenticated(b))return json(403,{error:'Contraseña incorrecta o ADMIN_PASSWORD no configurada (mínimo 12 caracteres)'});
   const eventData=await s.get('event',{type:'json'});
   if(action==='admin-status')return json(200,{exists:!!eventData,event:eventData?{people:eventData.people.map(p=>({id:p.id,name:p.name,phone:p.phone,link:p.link})),assignments:eventData.assignments,config:eventData.config}:null});
   if(action==='admin-wishes') {
    if(!eventData)return json(404,{error:'Todavía no existe un sorteo'});
    const wishes=await Promise.all(eventData.people.map(async p=>({id:p.id,name:p.name,wish:(await s.get('wish-'+p.id,{type:'text'}))||''})));
    return json(200,{wishes});
   }
   if(eventData)return json(409,{error:'Este sitio ya tiene un sorteo. Para evitar revelar o cambiar asignaciones, no se puede reemplazar. Usa otro sitio de ensayo para las pruebas.'});
   if(!Array.isArray(b.people)||b.people.length<3||b.people.length>50)return json(400,{error:'Registra entre 3 y 50 personas'});
   const people=b.people.map((p,i)=>({id:'p'+i,name:clean(p.name,90),phone:clean(p.phone,35)}));
   if(people.some(p=>!p.name)||new Set(people.map(p=>p.name.toLocaleLowerCase('es'))).size!==people.length)return json(400,{error:'Todos los nombres deben ser distintos y no estar vacíos'});
   const exclusions=[];
   if(!Array.isArray(b.exclusions)||b.exclusions.length>1500)return json(400,{error:'Exclusiones inválidas'});
   for(const pair of b.exclusions){if(!Array.isArray(pair)||pair.length!==2||pair.some(x=>!Number.isInteger(x)||x<0||x>=people.length))return json(400,{error:'Exclusión inválida'});if(pair[0]!==pair[1])exclusions.push(pair.map(i=>'p'+i));}
   const assignments=draw(people,exclusions);
   if(!assignments)return json(422,{error:'No existe un sorteo posible con esas exclusiones. Reduce algunas restricciones.'});
   const config={budget:clean(b.config?.budget,80),date:clean(b.config?.date,80)};
   const secretPeople=people.map(p=>({...p,link:token()}));
   await s.setJSON('event',{people:secretPeople.map(p=>({...p,tokenHash:hash(p.link)})),assignments,config});
   return json(200,{created:true,people:secretPeople,assignments,config});
  }
  if(action==='participant-read'||action==='participant-save') {
   const t=clean(b.token,200);
   if(!/^[A-Za-z0-9_-]{40,100}$/.test(t))return json(403,{error:'Enlace privado inválido'});
   const data=await s.get('event',{type:'json'});
   if(!data)return json(404,{error:'El sorteo aún no está publicado'});
   const p=data.people.find(p=>equal(p.tokenHash,hash(t)));
   if(!p)return json(403,{error:'Enlace privado inválido'});
   const recipient=data.people.find(x=>x.id===data.assignments[p.id]);
   if(!recipient)return json(500,{error:'Sorteo incompleto'});
   if(action==='participant-save'){
    if(typeof b.wish!=='string'||b.wish.length>2500)return json(400,{error:'Máximo 2500 caracteres'});
    await s.set('wish-'+p.id,b.wish.trim());
   }
   const [ownWish,recipientWish]=await Promise.all([s.get('wish-'+p.id,{type:'text'}),s.get('wish-'+recipient.id,{type:'text'})]);
   return json(200,{name:p.name,recipient:recipient.name,ownWish:ownWish||'',recipientWish:recipientWish||'',config:data.config});
  }
  return json(400,{error:'Acción desconocida'});
 }catch(e){console.error('Familia2026:',e);return json(500,{error:'No se pudo acceder al almacenamiento. Comprueba que Netlify Functions y Blobs estén activos.'});}
}
