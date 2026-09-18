/** Decode job-feed HTML as text only; never return markup for direct rendering. */
export function plainText(value) {
  let result=String(value??'');
  const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
  // Greenhouse may encode an already-encoded HTML document. Bound the passes.
  for(let pass=0;pass<3;pass++){
    const decoded=result.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(whole,code)=>{
      if(code[0]!=='#')return named[code.toLowerCase()]??whole;
      const n=code[1].toLowerCase()==='x'?parseInt(code.slice(2),16):parseInt(code.slice(1),10);
      return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):' ';
    });
    if(decoded===result)break;result=decoded;
  }
  return result.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,' ')
    .replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
}
