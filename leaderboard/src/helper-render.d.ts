declare module 'ai-work-assessment/profile-template' {
 export function renderProfileV9Document(profile:any,options?:any):string;
}
declare module 'ai-work-assessment/render' {
 export function addScriptNonce(html:string,nonce:string):string;
 export function profileDocumentHeaders(options:{nonce:string,published?:boolean}):Record<string,string>;
}
