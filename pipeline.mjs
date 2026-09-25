// 쿠팡 핫딜 파이프라인 (Node 20+, 외부 패키지 없음)
// 흐름: 쿠팡 파트너스 API(골드박스 + 키워드 검색) -> 가격 이력 저장 -> 딜 판정 -> 텔레그램 채널 발송 + 정적 사이트(docs/) 생성
//
// 환경변수
//   CP_ACCESS_KEY, CP_SECRET_KEY   쿠팡 파트너스 API 키 (최종승인 후 발급)
//   CP_SUB_ID                      채널 구분용 subId (선택, 예: tg / site / x)
//   TG_BOT_TOKEN, TG_CHAT_ID       텔레그램 봇 토큰, 채널 아이디(@채널명)
//   SITE_URL                       배포된 사이트 주소 (텔레그램 하단 링크용, 선택)
//   MOCK=경로.json                 API 대신 샘플 JSON으로 실행 (키 없이 테스트)
//   DRY_RUN=1                      텔레그램 실제 발송 없이 콘솔에만 출력

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const DOCS = path.join(ROOT, 'docs');
const env = process.env;
const DAY = 86400000;
const now = Date.now();

const CFG = {
  searchPerRun: 4,          // 검색 API는 시간당 10회 제한 -> 30분 주기 x 4회 = 시간당 8회
  maxPostsPerRun: 5,        // 도배 방지
  repostCooldownDays: 7,    // 같은 상품 재발송 금지 기간 (더 싸지면 예외)
  minHistoryDays: 3,        // "30일 최저" 판정에 필요한 최소 추적 기간
  quietHoursKST: [1, 7],    // 01~07시는 텔레그램 발송 안 함 (사이트는 갱신)
  // 표시광고법상 민감 품목: 가격 정보만 올려도 리스크가 있어 자동 발송에서 제외
  blockKeywords: ['분유', '조제유', '의료기기', '혈압계', '혈당', '보청기', '콘택트렌즈', '성인용'],
};

const DISCLOSURE = '이 게시물은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';

// ---------- 쿠팡 파트너스 API ----------
const CP_HOST = 'https://api-gateway.coupang.com';
const CP_BASE = '/v2/providers/affiliate_open_api/apis/openapi/v1';

function signedDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function cpAuth(method, pathname, query) {
  const dt = signedDate();
  const sig = crypto.createHmac('sha256', env.CP_SECRET_KEY).update(dt + method + pathname + query).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${env.CP_ACCESS_KEY}, signed-date=${dt}, signature=${sig}`;
}

async function cp(method, pathname, params, body) {
  const query = params ? new URLSearchParams(params).toString() : '';
  const url = CP_HOST + pathname + (query ? `?${query}` : '');
  const res = await fetch(url, {
    method,
    headers: { Authorization: cpAuth(method, pathname, query), 'Content-Type': 'application/json;charset=UTF-8' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.rCode && json.rCode !== '0')) {
    throw new Error(`Coupang API ${res.status} ${pathname}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json.data;
}

const sub = () => (env.CP_SUB_ID ? { subId: env.CP_SUB_ID } : {});
const cpGoldbox = () => cp('GET', `${CP_BASE}/products/goldbox`, sub());
const cpSearch = (keyword) => cp('GET', `${CP_BASE}/products/search`, { keyword, limit: 10, ...sub() });
export const cpDeeplink = (urls) => cp('POST', `${CP_BASE}/deeplink`, null, { coupangUrls: urls, ...sub() });

function normalize(p, source) {
  return {
    id: String(p.productId),
    name: String(p.productName || '').trim(),
    price: Number(p.productPrice),
    originalPrice: p.originalPrice ? Number(p.originalPrice) : null,
    image: p.productImage,
    url: p.productUrl, // API 응답의 productUrl은 이미 파트너스 트래킹 링크
    rocket: !!p.isRocket,
    category: p.categoryName || '',
    notes: Array.isArray(p.notes) ? p.notes : [],
    source,
  };
}

// ---------- 저장소 ----------
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 1));
}

// ---------- 딜 판정 ----------
const fmt = (n) => Number(n).toLocaleString('ko-KR');

function evaluate(p, h) {
  const prior = (h?.points || []).filter(([t]) => now - t <= 30 * DAY).map(([, v]) => v);
  const trackedDays = h?.points?.length ? (now - h.points[0][0]) / DAY : 0;
  const min30 = prior.length ? Math.min(...prior) : null;
  const max30 = prior.length ? Math.max(...prior) : null;
  const reasons = [];
  let score = 0;

  if (p.source === 'goldbox') { score += 2; reasons.push('쿠팡 골드박스 타임딜'); }
  if (p.source === 'manual') { score += 2; reasons.push(...(p.notes || [])); }
  if (p.originalPrice && p.originalPrice > p.price) {
    const off = Math.round((1 - p.price / p.originalPrice) * 100);
    if (off >= 20) { score += 1; reasons.push(`표시 할인율 ${off}%`); }
  }
  if (min30 && trackedDays >= CFG.minHistoryDays && p.price < min30) {
    score += 3; reasons.push(`추적 ${Math.floor(trackedDays)}일 중 최저 (이전 최저 ${fmt(min30)}원)`);
  }
  if (max30 && p.price <= max30 * 0.85) {
    score += 1; reasons.push(`30일 최고가 대비 -${Math.round((1 - p.price / max30) * 100)}%`);
  }
  return { score, reasons, min30, max30, trackedDays };
}

function shouldPost(p, h, ev) {
  if (ev.score < 2) return false;
  if (CFG.blockKeywords.some((k) => p.name.includes(k))) return false;
  if (h?.lastPostedAt && now - h.lastPostedAt < CFG.repostCooldownDays * DAY) {
    return p.price < (h.lastPostedPrice ?? Infinity); // 쿨다운 중이면 더 싸졌을 때만
  }
  return true;
}

function record(history, p) {
  const h = (history[p.id] ||= { name: p.name, image: p.image, points: [] });
  h.name = p.name; h.image = p.image; h.url = p.url;
  const last = h.points.at(-1);
  if (!last || last[1] !== p.price || now - last[0] > 6 * 3600000) h.points.push([now, p.price]);
  h.points = h.points.filter(([t]) => now - t <= 90 * DAY);
  return h;
}

// ---------- 텔레그램 ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function caption(d) {
  const priceLine = d.originalPrice && d.originalPrice > d.price
    ? `<b>${fmt(d.price)}원</b> (표시가 ${fmt(d.originalPrice)}원)`
    : `<b>${fmt(d.price)}원</b>`;
  return [
    `<i>[광고] ${esc(DISCLOSURE)}</i>`,
    '',
    `<b>${esc(d.name)}</b>`,
    priceLine,
    ...d.reasons.map((r) => `- ${esc(r)}`),
    '',
    `<a href="${esc(d.url)}">쿠팡에서 보기</a>`,
    env.SITE_URL ? `가격 추이: ${esc(env.SITE_URL)}` : '',
    '가격은 발송 시점 기준이며 바로 바뀔 수 있어요.',
  ].filter((x) => x !== '').join('\n').slice(0, 1024);
}

function inQuietHours() {
  const h = (new Date().getUTCHours() + 9) % 24;
  const [a, b] = CFG.quietHoursKST;
  return h >= a && h < b;
}

async function tgSend(d) {
  const text = caption(d);
  if (env.DRY_RUN || !env.TG_BOT_TOKEN) { console.log('\n--- [DRY RUN] 텔레그램 ---\n' + text.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '\"')); return true; }
  const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, photo: d.image, caption: text, parse_mode: 'HTML' }),
  });
  const j = await res.json();
  if (!j.ok) console.error('telegram error', j.description);
  return j.ok;
}

// ---------- 정적 사이트 ----------
function sparkline(points) {
  if (!points || points.length < 2) return '';
  const vs = points.map(([, v]) => v), ts = points.map(([t]) => t);
  const [minV, maxV, minT, maxT] = [Math.min(...vs), Math.max(...vs), Math.min(...ts), Math.max(...ts)];
  const W = 220, H = 44;
  const xy = points.map(([t, v]) => [
    ((t - minT) / (maxT - minT || 1)) * W,
    H - 4 - ((v - minV) / (maxV - minV || 1)) * (H - 8),
  ]);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}"><polyline fill="none" stroke="#ff5a1f" stroke-width="2" points="${xy.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')}"/></svg>
  <div class="range">추적 최저 ${fmt(minV)}원 · 최고 ${fmt(maxV)}원</div>`;
}

function renderSite(feed, history) {
  const cards = feed.map((d) => `
  <article class="card">
    <img src="${esc(d.image)}" alt="" loading="lazy">
    <div class="body">
      <div class="src">${d.source === 'goldbox' ? '골드박스' : d.source === 'manual' ? '에디터 픽' : '가격하락'} · ${new Date(d.postedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
      <h2>${esc(d.name)}</h2>
      <div class="price">${fmt(d.price)}원${d.originalPrice && d.originalPrice > d.price ? ` <s>${fmt(d.originalPrice)}원</s> <b>-${Math.round((1 - d.price / d.originalPrice) * 100)}%</b>` : ''}</div>
      <ul>${d.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      ${sparkline(history[d.id]?.points)}
      <a class="buy" href="${esc(d.url)}" target="_blank" rel="sponsored nofollow noopener">쿠팡에서 보기</a>
    </div>
  </article>`).join('');

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>딜로그 · 가격 추적 핫딜</title>
<meta name="description" content="쿠팡 골드박스와 가격 하락 상품을 자동으로 추적해 모아봅니다.">
<style>
*{box-sizing:border-box}body{margin:0;font-family:Pretendard,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:#f4f5f7;color:#111}
.disc{background:#fff4e5;color:#7a4b00;font-size:13px;padding:10px 16px;text-align:center;border-bottom:1px solid #ffd9a8}
header{max-width:960px;margin:0 auto;padding:22px 16px 6px;display:flex;justify-content:space-between;align-items:end;gap:12px;flex-wrap:wrap}
h1{margin:0;font-size:24px}header p{margin:4px 0 0;color:#666;font-size:14px}
.tg{background:#229ED9;color:#fff;text-decoration:none;padding:10px 14px;border-radius:10px;font-weight:700;font-size:14px}
main{max-width:960px;margin:0 auto;padding:12px 16px 40px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.card{background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);display:flex;flex-direction:column}
.card img{width:100%;aspect-ratio:1/1;object-fit:contain;background:#fff;padding:10px}
.body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:6px;flex:1}
.src{font-size:12px;color:#ff5a1f;font-weight:700}
h2{font-size:15px;line-height:1.35;margin:0;font-weight:600}
.price{font-size:20px;font-weight:800}.price s{font-size:13px;color:#999;font-weight:400}.price b{color:#e02020;font-size:15px}
ul{margin:0;padding-left:18px;font-size:13px;color:#444}
.spark{width:100%;height:44px}.range{font-size:12px;color:#888}
.buy{margin-top:auto;display:block;text-align:center;background:#111;color:#fff;text-decoration:none;padding:10px;border-radius:10px;font-weight:700}
footer{max-width:960px;margin:0 auto;padding:0 16px 30px;color:#888;font-size:12px;line-height:1.6}
</style></head><body>
<div class="disc">[광고] ${esc(DISCLOSURE)}</div>
<header><div><h1>딜로그</h1><p>쿠팡 골드박스 + 자체 가격 추적으로 떨어진 상품만 모았어요. 업데이트 ${new Date(now).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p></div>
${env.TG_CHAT_ID ? `<a class="tg" href="https://t.me/${esc(String(env.TG_CHAT_ID).replace('@', ''))}">텔레그램으로 실시간 알림 받기</a>` : ''}</header>
<main>${cards || '<p>아직 등록된 딜이 없어요.</p>'}</main>
<footer>가격과 재고는 게시 시점 기준이며 쿠팡에서 수시로 바뀔 수 있습니다. "추적 최저"는 이 사이트가 직접 기록한 가격 기준입니다.<br>${esc(DISCLOSURE)}</footer>
</body></html>`;
}

// ---------- 메인 ----------
async function collect(state) {
  if (env.MOCK) {
    const raw = JSON.parse(await fs.readFile(path.resolve(ROOT, env.MOCK), 'utf8'));
    return raw.map((p) => normalize(p, 'goldbox'));
  }
  // 수동 모드: manual.json 에 파트너스 링크로 직접 넣은 딜 (API 승인 전 단계에서 사용)
  const manual = (await readJson(path.join(ROOT, 'manual.json'), [])).map((p) => normalize(p, 'manual'));
  if (!env.CP_ACCESS_KEY || !env.CP_SECRET_KEY) {
    console.log('API 키 없음 -> 수동 모드 (manual.json)');
    return manual;
  }
  const out = [...manual, ...(await cpGoldbox()).map((p) => normalize(p, 'goldbox'))];
  const keywords = await readJson(path.join(ROOT, 'keywords.json'), []);
  for (let i = 0; i < Math.min(CFG.searchPerRun, keywords.length); i++) {
    const kw = keywords[(state.kwIndex + i) % keywords.length];
    try {
      const r = await cpSearch(kw);
      out.push(...(r?.productData || []).map((p) => normalize(p, `search:${kw}`)));
    } catch (e) { console.error(e.message); }
  }
  state.kwIndex = (state.kwIndex + CFG.searchPerRun) % Math.max(keywords.length, 1);
  return out;
}

async function main() {
  const history = await readJson(path.join(DATA, 'prices.json'), {});
  const state = await readJson(path.join(DATA, 'state.json'), { kwIndex: 0 });
  const feed = await readJson(path.join(DATA, 'feed.json'), []);

  const products = [...new Map((await collect(state)).map((p) => [p.id, p])).values()];
  const candidates = [];
  for (const p of products) {
    if (!p.id || !p.price) continue;
    const ev = evaluate(p, history[p.id]);           // 기록 전에 판정 (현재가가 비교 기준을 오염시키지 않게)
    const h = record(history, p);
    if (shouldPost(p, h, ev)) candidates.push({ ...p, ...ev, h });
  }
  candidates.sort((a, b) => b.score - a.score);

  let posted = 0;
  for (const d of candidates.slice(0, CFG.maxPostsPerRun)) {
    const deal = { ...d, postedAt: now };
    if (!inQuietHours() || env.DRY_RUN) await tgSend(deal);
    d.h.lastPostedAt = now; d.h.lastPostedPrice = d.price;
    delete deal.h;
    feed.unshift(deal);
    posted++;
  }
  const fresh = feed.filter((d) => now - d.postedAt <= 2 * DAY).slice(0, 60);

  await writeJson(path.join(DATA, 'prices.json'), history);
  await writeJson(path.join(DATA, 'state.json'), state);
  await writeJson(path.join(DATA, 'feed.json'), fresh);
  await fs.mkdir(DOCS, { recursive: true });
  await fs.writeFile(path.join(DOCS, 'index.html'), renderSite(fresh, history));
  console.log(`\n수집 ${products.length}개 / 후보 ${candidates.length}개 / 발송 ${posted}개 / 사이트 ${fresh.length}개 노출`);
}

main().catch((e) => { console.error(e); process.exit(1); });


