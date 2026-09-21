import {lookup as dnsLookup} from 'node:dns/promises';
import {httpsUrl,text} from './core.mjs';
import {plainText} from './text.mjs';
import {assertSafeReceipt,receiptSha256} from './receipts.mjs';

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;

function evidenceText(value) {
  return plainText(value).normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

function publicIp(address) {
  const v4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some(n => n > 255)) return false;
    const [a,b] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)));
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return publicIp(normalized.slice(7));
  return normalized !== '::' && normalized !== '::1' && !normalized.startsWith('fc') && !normalized.startsWith('fd') && !normalized.startsWith('fe80:') && !normalized.startsWith('ff');
}

async function publicSourceUrl(value, resolver) {
  const normalized = httpsUrl(value);
  if (!normalized) throw new Error('Partner source needs an HTTPS URL');
  const {hostname} = new URL(normalized);
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('Partner source host must be public');
  const addresses = await resolver(hostname, {all:true,verbatim:true});
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(record => !publicIp(record.address))) throw new Error('Partner source host must resolve only to public addresses');
  return normalized;
}

async function boundedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty partner source response');
  const chunks = []; let size = 0;
  while (true) {
    const {done,value} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RECEIPT_BYTES) {
      await reader.cancel();
      throw new Error('Partner source response exceeds 2 MB');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Collect a single explicit, employer-published partnership route. This never
 * sends a form or promotes a route to outreach eligibility; callers must
 * review the provisional record before using it in a campaign.
 */
export async function collectPartnerRoute(source, {fetcher=fetch,resolver=dnsLookup,now=Date.now()} = {}) {
  if (!source || typeof source !== 'object' || source.company_id == null || !text(source.company_name)) throw new Error('Partner source needs company_id and company_name');
  const sourceUrl = await publicSourceUrl(source.source_url, resolver);
  const routeUrl = httpsUrl(source.route_url ?? source.source_url);
  if (!routeUrl) throw new Error('Partner route needs an HTTPS URL');
  const excerpt = evidenceText(source.evidence_excerpt);
  if (!excerpt) throw new Error('Partner source needs an evidence excerpt');
  const response = await fetcher(sourceUrl, {headers:{Accept:'text/html, text/plain;q=0.9','User-Agent':'OrganizedAI-GTM/1.0'},signal:AbortSignal.timeout(20000),redirect:'error'});
  if (!response.ok) throw new Error(`Partner source returned HTTP ${response.status}`);
  const receipt = await boundedBody(response);
  assertSafeReceipt(receipt);
  const page = evidenceText(receipt.toString('utf8'));
  if (!page.toLocaleLowerCase().includes(excerpt.toLocaleLowerCase())) throw new Error('Partner evidence excerpt was not found in source');
  return {
    contact:{company_id:source.company_id,kind:'web-route',value:routeUrl,purpose:'partnerships',name:text(source.name) || `${text(source.company_name)} partnership route`,title_or_function:text(source.title_or_function) || 'Partner Program',url:sourceUrl,checked_at:new Date(now).toISOString(),verification:'published-route-needs-review',evidence_excerpt:excerpt,recipient_approved:false,outreach_authorized:false},
    receipt,
    source_sha256:receiptSha256(receipt),
  };
}
