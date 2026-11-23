import { sign } from 'node:crypto';

const spreadsheet = '1vQjPZYVQzmSE6hioUMBgkbcfw8RC4xARn47ctHAqlSE';
const fields = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const roles = new Set(['', 'Diretor(a)', 'Professor(a)', 'TI', 'Coordenador(a)', 'Mantenedor(a)', 'Secretaria escolar', 'Outro']);
const value = (input, maxlength) => typeof input === 'string' ? input.trim().slice(0, maxlength) : '';
const encode = (input) => Buffer.from(JSON.stringify(input)).toString('base64url');
let cachedToken;

async function accessToken() {
  if (cachedToken?.expiration > Date.now()) return cachedToken.token;
  const {client_email, private_key} = JSON.parse(process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now()/1000);
  const audience = 'https://oauth2.googleapis.com/token';
  const header = encode({alg:'RS256',typ:'JWT'});
  const claims = encode({iss:client_email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:audience,iat:now,exp:now+3600});
  const unsigned = header+'.'+claims;
  const assertion = unsigned+'.'+sign('RSA-SHA256',Buffer.from(unsigned),private_key).toString('base64url');
  const res = await fetch(audience,{method:'POST',body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}),signal:AbortSignal.timeout(7000)});
  if (!res.ok) throw new Error('Google OAuth '+res.status);
  const {access_token,expires_in} = await res.json();
  cachedToken = {token:access_token,expiration:Date.now()+Math.max(0,expires_in-60)*1000};
  return access_token;
}

async function saveRow(row) {
  const token = await accessToken();
  const endpoint = 'https://sheets.googleapis.com/v4/spreadsheets/'+spreadsheet+'/values/';
  const headers = {Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const ids = await fetch(endpoint+encodeURIComponent("'Página1'!L2:L"),{headers,signal:AbortSignal.timeout(7000)});
  if (!ids.ok) throw new Error('Google Sheets read '+ids.status);
  const existing = (await ids.json()).values ?? [];
  if (existing.some(([id])=>id === row[11])) return;
  const result = await fetch(endpoint+encodeURIComponent("'Página1'!A:L")+':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',{
    method:'POST',headers,body:JSON.stringify({values:[row]}),signal:AbortSignal.timeout(7000)
  });
  if (!result.ok) throw new Error('Google Sheets append '+result.status);
}

export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if (req.method !== 'POST') return res.status(405).json({message:'Método não permitido.'});
  if (req.headers.origin !== 'https://'+req.headers.host || !req.headers['content-type']?.startsWith('application/json')) {
    return res.status(403).json({message:'Abra a página da Exitus e tente novamente.'});
  }
  const data = req.body ?? {};
  const name = value(data.name,120);
  const city = value(data.city,120);
  const email = value(data.email,254).toLowerCase();
  const role = value(data.role,80);
  const rawPhone = value(data.phone,24);
  const digits = rawPhone.replace(/\D/g,'');
  const phone = digits.length >= 12 && digits.startsWith('55') ? digits.slice(2) : digits;
  const id = value(data.id,36);
  if (name.length < 2 || city.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^[+\d()\s.-]+$/.test(rawPhone) || !/^[1-9]{2}(?:[2-5]\d{7}|9\d{8})$/.test(phone) || !roles.has(role) || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(id)) {
    return res.status(422).json({message:'Confira o nome, o telefone com DDD, o e-mail e a cidade.'});
  }
  if (!process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON) {
    return res.status(503).json({message:'O formulário está em prévia. O envio será liberado quando a planilha estiver conectada.'});
  }
  try {
    await saveRow([new Date().toISOString(),name,phone,email,role,city,...fields.map((key)=>value(data[key],200)),id]);
    return res.status(201).json({ok:true});
  } catch (error) {
    console.error('Lead persistence failed', error.message);
    return res.status(503).json({message:'Não conseguimos registrar agora. Tente novamente.'});
  }
}
