import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
const groups=[
{title:'Recording and consent evidence',intro:'ActiveProspect is a platform. TrustedForm is the closest comparison to Page Tracker; LeadConduit is a separate lead-processing product.',rows:[
['Primary purpose','Consent capture, certification and evidence retention for lead generation. [1]','Self-hosted page-action recording and MP4 playback.','Add a structured consent-evidence workflow.'],
['Script integration','JavaScript SDK captures webpage content and events. [2]','Single script tag in rendered HTML, PHP/Blade views or shared layouts.','Common capability.'],
['Interaction capture','DOM snapshots, clicks, keystrokes and mouse movements. [1,2]','DOM mutations, clicks, inputs, scrolls and pointer movement, with redaction.','Common foundation; capture rules differ.'],
['Replay / video','Reconstructs the session; replay is not a traditional video file. [3]','Server renders rrweb events into downloadable H.264 MP4.','Direct MP4 is a project differentiator.'],
['Certificates','Unique certificate URL linked to the captured consumer experience. [2,3]','Recording UUID and authenticated session-details page.','Missing a dedicated certificate and certificate URL.'],
['Consent disclosure','Documents consent language and interaction context. [1,4]','Visible text may be captured, but disclosure is not separately identified or versioned.','Store disclosure version, consent action and timestamp.'],
['Lead matching','Matches submitted contact details against captured session information. [2]','Optional visitor name/ID; no verified contact matching.','Add lead IDs and contact fingerprints.'],
['Metadata','Includes IP address, browser and geolocation context. [1]','URL/domain, browser string, timestamps, duration and optional visitor identity.','Add evidence metadata only where justified.']
]},
{title:'Integrity, access and operations',intro:'Shared recording capabilities do not make the current project equivalent to a consent-certification service.',rows:[
['Record integrity','ActiveProspect describes retained certificates as immutable records. [4]','Signed upload tokens; stored files are not tamper-evident certificates.','Add file hashes, signed manifests and append-only audit logs.'],
['Retention','Retain typically supports certificate storage for up to five years. [2,4]','Default 30 days, configurable; scheduled pruning required.','Add archival, per-account retention policies and storage planning.'],
['Automatic retention','Auto-Retain is available for verified domains. [5]','Recordings finalize on selected page actions; refresh/tab close does not create an MP4.','Build explicit consent/certificate retention rules.'],
['Domain check','Auto-Retain requires domain verification. [5]','Signup checks whether the root URL returns HTTP 200.','Availability is not ownership verification.'],
['APIs','Certificate operations include Retain, Verify and Insights. [1]','Recording initialization/uploads, listing, video status and download.','Add certificate validation and retention APIs.'],
['Sensitive data','Sensitive elements can be marked for special handling. [2]','Sensitive-field redaction plus mask/ignore attributes.','Common capability; improve configurable policies and tests.'],
['CRM integration','Certificate workflows integrate with lead-acquisition systems. [3,4]','No generic CRM delivery or webhook workflow.','Add lead mapping, signed webhooks and connectors.'],
['Hosting / access','Managed service with certificate access and management. [3,4]','Node/MySQL, local files, company isolation and master-admin dashboard.','Self-hosting provides control but requires backups and monitoring.']
]},
];
const sources=[
['1','TrustedForm overview','https://support.activeprospect.com/hc/en-us/articles/44098172771988-Overview-of-TrustedForm'],
['2','TrustedForm Certify','https://support.activeprospect.com/hc/en-us/articles/44098177422996'],
['3','Certificates and session replay','https://support.activeprospect.com/hc/en-us/articles/44098159927316'],
['4','TrustedForm Retain','https://support.activeprospect.com/hc/en-us/articles/44098160385044'],
['5','TrustedForm Auto-Retain','https://activeprospect.com/trustedform/auto-retain/'],
['6','LeadConduit overview','https://support.activeprospect.com/hc/en-us/articles/44098191771668-Overview-of-LeadConduit'],
['7','LeadConduit rules','https://support.activeprospect.com/hc/en-us/articles/44098322340756-Configuring-Rules']
];
const esc=x=>x.replaceAll('&','&amp;').replaceAll('<','&lt;');
const table=(heads,rows)=>'<table><thead><tr>'+heads.map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map((x,i)=>'<td'+(i===0?' class="label"':'')+'>'+esc(x)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
const html=`<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:A4 landscape;margin:15mm 15mm 17mm}
*{box-sizing:border-box}body{font:10.5px/1.45 Arial,sans-serif;color:#24324a;margin:0}
.page{break-after:page}.page:last-child{break-after:auto}
.eyebrow{font-size:9px;letter-spacing:1.7px;color:#536481;text-transform:uppercase;margin-bottom:7px}
h1{font-size:25px;line-height:1.2;margin:0 0 9px;color:#14243e}h2{font-size:16px;margin:18px 0 8px}
p{margin:0 0 13px;max-width:900px;color:#4c5c73}
table{width:100%;border-collapse:collapse;table-layout:fixed;margin-top:12px}
th{background:#172a46;color:white;text-align:left;padding:9px;font-size:10px}
td{padding:9px;vertical-align:top;border-bottom:1px solid #dce3ed}
tr:nth-child(even) td{background:#f3f6fa}tr{break-inside:avoid}
th:first-child{width:17%}.label{font-weight:bold}a{color:#244c91;text-decoration:none}
.note{border-left:3px solid #536d96;background:#f1f5fa;padding:10px 12px;margin-top:13px}
.sources{display:grid;grid-template-columns:1fr 1fr;gap:5px 22px;font-size:10px}
</style></head><body>
${groups.map((g,i)=>`<section class="page"><div class="eyebrow">Product comparison / 05 October 2026 / ${i+1} of 3</div><h1>${i===0?'ActiveProspect vs Page Tracker':g.title}</h1><p>${g.intro}</p>${table(['Feature','ActiveProspect / TrustedForm','Our Page Tracker','Gap / recommendation'],g.rows)}<div class="note">${i===0?'Scope: current project implementation compared with official ActiveProspect documentation. References [1]-[7] are clickable on page 3.':'Current limitation: HTTP 200 confirms reachability, not ownership. Registered Origin checks can be forged by non-browser clients and are not secret sender authentication.'}</div></section>`).join('')}
<section class="page"><div class="eyebrow">Product comparison / roadmap and references / 3 of 3</div><h1>What to build next</h1><p>Recommended sequence if the goal is a TrustedForm-style product. These are proposed additions, not existing capabilities.</p>
${table(['Priority','Addition','Business purpose'],[
['1','Structured consent capture','Record disclosure text/version, affirmative action and timestamp.'],
['2','Certificate ID / URL and lead matching','Link evidence to the exact submitted lead.'],
['3','Evidence integrity and archival','Signed manifests, protected storage, audit logs and retention controls.'],
['4','Verification API and CRM webhooks','Integrate evidence checks and delivery into buyer workflows.'],
['5','Lead-quality insights and routing','Extend beyond recording into lead-processing functionality.']
])}
<h2>Separate product: LeadConduit</h2><p>ActiveProspect also offers lead validation/enrichment, acceptance rules, routing, conditional pricing and third-party validation integrations through LeadConduit. These are not TrustedForm replay features and are not implemented in our project. [6,7]</p>
<div class="note"><b>Important distinction:</b> An MP4 recording alone is not equivalent to a TrustedForm certificate or a guarantee of legally sufficient consent evidence. The project currently provides a recording foundation, not a complete consent-certification service.</div>
<h2>Sources and review basis</h2><div class="sources">${sources.map(([n,t,u])=>`<div>[${n}] <a href="${u}">${t}</a></div>`).join('')}<div>Project: README.md; account, recording, storage and dashboard implementation reviewed in this workspace.</div></div>
<p style="margin-top:12px;font-size:9px">Vendor capabilities are based on the official documentation consulted for this comparison. Availability can vary by product configuration or contract. No pricing comparison is included.</p></section></body></html>`;
await writeFile('tmp/pdfs/comparison.html',html);
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true});
const page=await browser.newPage();
await page.setContent(html);
await page.pdf({path:'output/pdf/activeprospect-vs-page-tracker.pdf',format:'A4',landscape:true,printBackground:true,displayHeaderFooter:true,headerTemplate:'<span></span>',footerTemplate:'<div style="font:9px Arial;color:#68768a;width:100%;padding:0 15mm;display:flex;justify-content:space-between"><span>Page Tracker / ActiveProspect comparison</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',preferCSSPageSize:true});
await browser.close();
