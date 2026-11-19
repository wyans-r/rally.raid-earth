/* Rally Raid share links.
 * Packs a stage or a roadbook into the URL #fragment (compressed, then base64url)
 * so you can send a link and the other browser opens it directly. Nothing is stored
 * online, and the server never sees the data.
 *
 * Fragment versions:  #s1=...  a stage (opens in the builder)
 *                     #r1=...  a roadbook plus its stage (opens in the editor)
 *                     #y1=...  a rally file (not public: the rally viewer is retracted)
 *                     #k1=<id> a short link: the same payload stored on the site (POST /api/share, KV), fetched
 *                              from /api/share/<id>. The public form is /s/<id>; the page rewrites it to #k1=<id>.
 * Short links (19 Nov 2026): Share tries a short link first and falls back to the long link automatically;
 * "Copy long link" always makes the long one. Long links keep working unchanged.
 *
 * Compression uses a minified subset of fflate (deflateSync / inflateSync),
 * MIT License, Copyright (c) Arjun Barrett, https://github.com/101arrowz/fflate
 * so creating and opening links works on iOS 15 (no CompressionStream) as well as
 * current browsers.
 */
(function (root) {
  'use strict';
  var fflateShare = (()=>{var vr=Object.defineProperty;var Pr=Object.getOwnPropertyDescriptor;var $r=Object.getOwnPropertyNames;var Hr=Object.prototype.hasOwnProperty;var Nr=(r,n)=>{for(var t in n)vr(r,t,{get:n[t],enumerable:!0})},Rr=(r,n,t,e)=>{if(n&&typeof n=="object"||typeof n=="function")for(let i of $r(n))!Hr.call(r,i)&&i!==t&&vr(r,i,{get:()=>n[i],enumerable:!(e=Pr(n,i))||e.enumerable});return r};var Vr=r=>Rr(vr({},"__esModule",{value:!0}),r);var nn={};Nr(nn,{deflateSync:()=>Gr,inflateSync:()=>Or,strFromU8:()=>Lr,strToU8:()=>qr});var A=Uint8Array,H=Uint16Array,Ar=Int32Array,fr=new A([0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0,0,0,0]),hr=new A([0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13,0,0]),yr=new A([16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]),Dr=function(r,n){for(var t=new H(31),e=0;e<31;++e)t[e]=n+=1<<r[e-1];for(var i=new Ar(t[30]),e=1;e<30;++e)for(var a=t[e];a<t[e+1];++a)i[a]=a-t[e]<<5|e;return{b:t,r:i}},Cr=Dr(fr,2),Ir=Cr.b,wr=Cr.r;Ir[28]=258,wr[258]=28;var Br=Dr(hr,0),Wr=Br.b,Sr=Br.r,mr=new H(32768);for(c=0;c<32768;++c)K=(c&43690)>>1|(c&21845)<<1,K=(K&52428)>>2|(K&13107)<<2,K=(K&61680)>>4|(K&3855)<<4,mr[c]=((K&65280)>>8|(K&255)<<8)>>1;var K,c,j=(function(r,n,t){for(var e=r.length,i=0,a=new H(n);i<e;++i)r[i]&&++a[r[i]-1];var f=new H(n);for(i=1;i<n;++i)f[i]=f[i-1]+a[i-1]<<1;var u;if(t){u=new H(1<<n);var g=15-n;for(i=0;i<e;++i)if(r[i])for(var l=i<<4|r[i],o=n-r[i],s=f[r[i]-1]++<<o,v=s|(1<<o)-1;s<=v;++s)u[mr[s]>>g]=l}else for(u=new H(e),i=0;i<e;++i)r[i]&&(u[i]=mr[f[r[i]-1]++]>>15-r[i]);return u}),k=new A(288);for(c=0;c<144;++c)k[c]=8;var c;for(c=144;c<256;++c)k[c]=9;var c;for(c=256;c<280;++c)k[c]=7;var c;for(c=280;c<288;++c)k[c]=8;var c,ar=new A(32);for(c=0;c<32;++c)ar[c]=5;var c,Yr=j(k,9,0),jr=j(k,9,1),Jr=j(ar,5,0),Kr=j(ar,5,1),cr=function(r){for(var n=r[0],t=1;t<r.length;++t)r[t]>n&&(n=r[t]);return n},V=function(r,n,t){var e=n/8|0;return(r[e]|r[e+1]<<8)>>(n&7)&t},pr=function(r,n){var t=n/8|0;return(r[t]|r[t+1]<<8|r[t+2]<<16)>>(n&7)},Mr=function(r){return(r+7)/8|0},ur=function(r,n,t){return(n==null||n<0)&&(n=0),(t==null||t>r.length)&&(t=r.length),new A(r.subarray(n,t))};var Qr=["unexpected EOF","invalid block type","invalid length/literal","invalid distance","stream finished","no stream handler",,"no callback","invalid UTF-8 data","extra field too long","date not in range 1980-2099","filename too long","stream finishing","invalid zip data"],Y=function(r,n,t){var e=new Error(n||Qr[r]);if(e.code=r,Error.captureStackTrace&&Error.captureStackTrace(e,Y),!t)throw e;return e},Xr=function(r,n,t,e){var i=r.length,a=e?e.length:0;if(!i||n.f&&!n.l)return t||new A(0);var f=!t,u=f||n.i!=2,g=n.i;f&&(t=new A(i*3));var l=function(nr){var tr=t.length;if(nr>tr){var _=new A(Math.max(tr*2,nr));_.set(t),t=_}},o=n.f||0,s=n.p||0,v=n.b||0,y=n.l,D=n.d,w=n.m,E=n.n,R=i*8;do{if(!y){o=V(r,s,1);var q=V(r,s+1,3);if(s+=3,q)if(q==1)y=jr,D=Kr,w=9,E=5;else if(q==2){var Z=V(r,s,31)+257,S=V(r,s+10,15)+4,p=Z+V(r,s+5,31)+1;s+=14;for(var h=new A(p),U=new A(19),z=0;z<S;++z)U[yr[z]]=V(r,s+z*3,7);s+=S*3;for(var I=cr(U),X=(1<<I)-1,L=j(U,I,1),z=0;z<p;){var G=L[V(r,s,X)];s+=G&15;var M=G>>4;if(M<16)h[z++]=M;else{var F=0,m=0;for(M==16?(m=3+V(r,s,3),s+=2,F=h[z-1]):M==17?(m=3+V(r,s,7),s+=3):M==18&&(m=11+V(r,s,127),s+=7);m--;)h[z++]=F}}var O=h.subarray(0,Z),T=h.subarray(Z);w=cr(O),E=cr(T),y=j(O,w,1),D=j(T,E,1)}else Y(1);else{var M=Mr(s)+4,B=r[M-4]|r[M-3]<<8,C=M+B;if(C>i){g&&Y(0);break}u&&l(v+B),t.set(r.subarray(M,C),v),n.b=v+=B,n.p=s=C*8,n.f=o;continue}if(s>R){g&&Y(0);break}}u&&l(v+131072);for(var rr=(1<<w)-1,N=(1<<E)-1,J=s;;J=s){var F=y[pr(r,s)&rr],P=F>>4;if(s+=F&15,s>R){g&&Y(0);break}if(F||Y(2),P<256)t[v++]=P;else if(P==256){J=s,y=null;break}else{var $=P-254;if(P>264){var z=P-257,x=fr[z];$=V(r,s,(1<<x)-1)+Ir[z],s+=x}var W=D[pr(r,s)&N],d=W>>4;W||Y(3),s+=W&15;var T=Wr[d];if(d>3){var x=hr[d];T+=pr(r,s)&(1<<x)-1,s+=x}if(s>R){g&&Y(0);break}u&&l(v+131072);var b=v+$;if(v<T){var or=a-T,sr=Math.min(T,b);for(or+v<0&&Y(3);v<sr;++v)t[v]=e[or+v]}for(;v<b;++v)t[v]=t[v-T]}}n.l=y,n.p=J,n.b=v,n.f=o,y&&(o=1,n.m=w,n.d=D,n.n=E)}while(!o);return v!=t.length&&f?ur(t,0,v):t.subarray(0,v)},Q=function(r,n,t){t<<=n&7;var e=n/8|0;r[e]|=t,r[e+1]|=t>>8},er=function(r,n,t){t<<=n&7;var e=n/8|0;r[e]|=t,r[e+1]|=t>>8,r[e+2]|=t>>16},gr=function(r,n){for(var t=[],e=0;e<r.length;++e)r[e]&&t.push({s:e,f:r[e]});var i=t.length,a=t.slice();if(!i)return{t:Er,l:0};if(i==1){var f=new A(t[0].s+1);return f[t[0].s]=1,{t:f,l:1}}t.sort(function(C,Z){return C.f-Z.f}),t.push({s:-1,f:25001});var u=t[0],g=t[1],l=0,o=1,s=2;for(t[0]={s:-1,f:u.f+g.f,l:u,r:g};o!=i-1;)u=t[t[l].f<t[s].f?l++:s++],g=t[l!=o&&t[l].f<t[s].f?l++:s++],t[o++]={s:-1,f:u.f+g.f,l:u,r:g};for(var v=a[0].s,e=1;e<i;++e)a[e].s>v&&(v=a[e].s);var y=new H(v+1),D=xr(t[o-1],y,0);if(D>n){var e=0,w=0,E=D-n,R=1<<E;for(a.sort(function(Z,S){return y[S.s]-y[Z.s]||Z.f-S.f});e<i;++e){var q=a[e].s;if(y[q]>n)w+=R-(1<<D-y[q]),y[q]=n;else break}for(w>>=E;w>0;){var M=a[e].s;y[M]<n?w-=1<<n-y[M]++-1:++e}for(;e>=0&&w;--e){var B=a[e].s;y[B]==n&&(--y[B],++w)}D=n}return{t:new A(y),l:D}},xr=function(r,n,t){return r.s==-1?Math.max(xr(r.l,n,t+1),xr(r.r,n,t+1)):n[r.s]=t},Ur=function(r){for(var n=r.length;n&&!r[--n];);for(var t=new H(++n),e=0,i=r[0],a=1,f=function(g){t[e++]=g},u=1;u<=n;++u)if(r[u]==i&&u!=n)++a;else{if(!i&&a>2){for(;a>138;a-=138)f(32754);a>2&&(f(a>10?a-11<<5|28690:a-3<<5|12305),a=0)}else if(a>3){for(f(i),--a;a>6;a-=6)f(8304);a>2&&(f(a-3<<5|8208),a=0)}for(;a--;)f(i);a=1,i=r[u]}return{c:t.subarray(0,e),n}},ir=function(r,n){for(var t=0,e=0;e<n.length;++e)t+=r[e]*n[e];return t},Zr=function(r,n,t){var e=t.length,i=Mr(n+2);r[i]=e&255,r[i+1]=e>>8,r[i+2]=r[i]^255,r[i+3]=r[i+1]^255;for(var a=0;a<e;++a)r[i+a+4]=t[a];return(i+4+e)*8},Fr=function(r,n,t,e,i,a,f,u,g,l,o){Q(n,o++,t),++i[256];for(var s=gr(i,15),v=s.t,y=s.l,D=gr(a,15),w=D.t,E=D.l,R=Ur(v),q=R.c,M=R.n,B=Ur(w),C=B.c,Z=B.n,S=new H(19),p=0;p<q.length;++p)++S[q[p]&31];for(var p=0;p<C.length;++p)++S[C[p]&31];for(var h=gr(S,7),U=h.t,z=h.l,I=19;I>4&&!U[yr[I-1]];--I);var X=l+5<<3,L=ir(i,k)+ir(a,ar)+f,G=ir(i,v)+ir(a,w)+f+14+3*I+ir(S,U)+2*S[16]+3*S[17]+7*S[18];if(g>=0&&X<=L&&X<=G)return Zr(n,o,r.subarray(g,g+l));var F,m,O,T;if(Q(n,o,1+(G<L)),o+=2,G<L){F=j(v,y,0),m=v,O=j(w,E,0),T=w;var rr=j(U,z,0);Q(n,o,M-257),Q(n,o+5,Z-1),Q(n,o+10,I-4),o+=14;for(var p=0;p<I;++p)Q(n,o+3*p,U[yr[p]]);o+=3*I;for(var N=[q,C],J=0;J<2;++J)for(var P=N[J],p=0;p<P.length;++p){var $=P[p]&31;Q(n,o,rr[$]),o+=U[$],$>15&&(Q(n,o,P[p]>>5&127),o+=P[p]>>12)}}else F=Yr,m=k,O=Jr,T=ar;for(var p=0;p<u;++p){var x=e[p];if(x>255){var $=x>>18&31;er(n,o,F[$+257]),o+=m[$+257],$>7&&(Q(n,o,x>>23&31),o+=fr[$]);var W=x&31;er(n,o,O[W]),o+=T[W],W>3&&(er(n,o,x>>5&8191),o+=hr[W])}else er(n,o,F[x]),o+=m[x]}return er(n,o,F[256]),o+m[256]},kr=new Ar([65540,131080,131088,131104,262176,1048704,1048832,2114560,2117632]),Er=new A(0),dr=function(r,n,t,e,i,a){var f=a.z||r.length,u=new A(e+f+5*(1+Math.ceil(f/7e3))+i),g=u.subarray(e,u.length-i),l=a.l,o=(a.r||0)&7;if(n){o&&(g[0]=a.r>>3);for(var s=kr[n-1],v=s>>13,y=s&8191,D=(1<<t)-1,w=a.p||new H(32768),E=a.h||new H(D+1),R=Math.ceil(t/3),q=2*R,M=function(lr){return(r[lr]^r[lr+1]<<R^r[lr+2]<<q)&D},B=new Ar(25e3),C=new H(288),Z=new H(32),S=0,p=0,h=a.i||0,U=0,z=a.w||0,I=0;h+2<f;++h){var X=M(h),L=h&32767,G=E[X];if(w[L]=G,E[X]=L,z<=h){var F=f-h;if((S>7e3||U>24576)&&(F>423||!l)){o=Fr(r,g,0,B,C,Z,p,U,I,h-I,o),U=S=p=0,I=h;for(var m=0;m<286;++m)C[m]=0;for(var m=0;m<30;++m)Z[m]=0}var O=2,T=0,rr=y,N=L-G&32767;if(F>2&&X==M(h-N))for(var J=Math.min(v,F)-1,P=Math.min(32767,h),$=Math.min(258,F);N<=P&&--rr&&L!=G;){if(r[h+O]==r[h+O-N]){for(var x=0;x<$&&r[h+x]==r[h+x-N];++x);if(x>O){if(O=x,T=N,x>J)break;for(var W=Math.min(N,x-2),d=0,m=0;m<W;++m){var b=h-N+m&32767,or=w[b],sr=b-or&32767;sr>d&&(d=sr,G=b)}}}L=G,G=w[L],N+=L-G&32767}if(T){B[U++]=268435456|wr[O]<<18|Sr[T];var nr=wr[O]&31,tr=Sr[T]&31;p+=fr[nr]+hr[tr],++C[257+nr],++Z[tr],z=h+O,++S}else B[U++]=r[h],++C[r[h]]}}for(h=Math.max(h,z);h<f;++h)B[U++]=r[h],++C[r[h]];o=Fr(r,g,l,B,C,Z,p,U,I,h-I,o),l||(a.r=o&7|g[o/8|0]<<3,o-=7,a.h=E,a.p=w,a.i=h,a.w=z)}else{for(var h=a.w||0;h<f+l;h+=65535){var _=h+65535;_>=f&&(g[o/8|0]=l,_=f),o=Zr(g,o+1,r.subarray(h,_))}a.i=f}return ur(u,0,e+Mr(o)+i)};var br=function(r,n,t,e,i){if(!i&&(i={l:1},n.dictionary)){var a=n.dictionary.subarray(-32768),f=new A(a.length+r.length);f.set(a),f.set(r,a.length),r=f,i.w=a.length}return dr(r,n.level==null?6:n.level,n.mem==null?i.l?Math.ceil(Math.max(8,Math.min(13,Math.log(r.length)))*1.5):20:12+n.mem,t,e,i)};function Gr(r,n){return br(r,n||{},0,0)}function Or(r,n){return Xr(r,{i:2},n&&n.out,n&&n.dictionary)}var Tr=typeof TextEncoder<"u"&&new TextEncoder,zr=typeof TextDecoder<"u"&&new TextDecoder,_r=0;try{zr.decode(Er,{stream:!0}),_r=1}catch{}var rn=function(r){for(var n="",t=0;;){var e=r[t++],i=(e>127)+(e>223)+(e>239);if(t+i>r.length)return{s:n,r:ur(r,t-1)};i?i==3?(e=((e&15)<<18|(r[t++]&63)<<12|(r[t++]&63)<<6|r[t++]&63)-65536,n+=String.fromCharCode(55296|e>>10,56320|e&1023)):i&1?n+=String.fromCharCode((e&31)<<6|r[t++]&63):n+=String.fromCharCode((e&15)<<12|(r[t++]&63)<<6|r[t++]&63):n+=String.fromCharCode(e)}};function qr(r,n){if(n){for(var t=new A(r.length),e=0;e<r.length;++e)t[e]=r.charCodeAt(e);return t}if(Tr)return Tr.encode(r);for(var i=r.length,a=new A(r.length+(r.length>>1)),f=0,u=function(o){a[f++]=o},e=0;e<i;++e){if(f+5>a.length){var g=new A(f+8+(i-e<<1));g.set(a),a=g}var l=r.charCodeAt(e);l<128||n?u(l):l<2048?(u(192|l>>6),u(128|l&63)):l>55295&&l<57344?(l=65536+(l&1047552)|r.charCodeAt(++e)&1023,u(240|l>>18),u(128|l>>12&63),u(128|l>>6&63),u(128|l&63)):(u(224|l>>12),u(128|l>>6&63),u(128|l&63))}return ur(a,0,f)}function Lr(r,n){if(n){for(var t="",e=0;e<r.length;e+=16384)t+=String.fromCharCode.apply(null,r.subarray(e,e+16384));return t}else{if(zr)return zr.decode(r);var i=rn(r),a=i.s,t=i.r;return t.length&&Y(8),a}}return Vr(nn);})();

  var SOFT = 2000, STRONG = 8000, VERY = 30000;
  var DAMAGED = 'This share link is damaged or was cut off (some messaging apps shorten long links). Ask for the file, or for a new link.';
  var NEWER = 'This share link was made by a newer version of the site and cannot be opened here.';

  function b64urlEncode(u8) {
    var CHUNK = 0x8000, s = '';
    for (var i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    var b64 = btoa(s);
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(s) {
    if (typeof s !== 'string' || !s) throw new Error(DAMAGED);
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin;
    try { bin = atob(s); } catch (e) { throw new Error(DAMAGED); }
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function encodePayload(obj) {
    var json = JSON.stringify(obj);
    var z = fflateShare.deflateSync(fflateShare.strToU8(json), { level: 9 });
    return b64urlEncode(z);
  }
  function decodePayload(s) {
    var u8 = b64urlDecode(s), raw;
    try { raw = fflateShare.inflateSync(u8); } catch (e) { throw new Error(DAMAGED); }
    var text;
    try { text = fflateShare.strFromU8(raw); } catch (e) { throw new Error(DAMAGED); }
    try { return JSON.parse(text); } catch (e) { throw new Error(DAMAGED); }
  }

  function parseHash(hash) {
    var h = String(hash == null ? '' : hash);
    if (h.charAt(0) === '#') h = h.slice(1);
    // ignore a leading slash some browsers add
    if (h.charAt(0) === '/') h = h.slice(1);
    var k = /^k(\d+)=([A-Za-z0-9]{22})$/.exec(h);
    if (k) return { kind: 'short', version: +k[1], id: k[2] };
    var m = /^(s|r|y)(\d+)=(.*)$/.exec(h);
    if (!m) return null;
    var kind = m[1] === 's' ? 'stage' : m[1] === 'r' ? 'roadbook' : 'rally';
    return { kind: kind, version: +m[2], data: m[3] };
  }

  function packStage(stage) {
    if (!stage || stage.format !== 'rallyraid-stage') throw new Error('not a rally raid stage file');
    return 's1=' + encodePayload(stage);
  }
  function packRoadbook(roadbook, stage) {
    if (!roadbook || roadbook.format !== 'rallyraid-roadbook') throw new Error('not a roadbook file');
    var payload = { roadbook: roadbook };
    if (stage) payload.stage = stage;
    return 'r1=' + encodePayload(payload);
  }
  function packRally(rally) {
    if (!rally || rally.format !== 'rallyraid-rally') throw new Error('not a rally raid rally file');
    return 'y1=' + encodePayload(rally);
  }

  function unpack(parsed) {
    if (!parsed) throw new Error(DAMAGED);
    if (parsed.version !== 1) throw new Error(NEWER);
    if (!parsed.data) throw new Error(DAMAGED);
    var obj = decodePayload(parsed.data);
    if (parsed.kind === 'stage') {
      if (!obj || obj.format !== 'rallyraid-stage') throw new Error('This share link is not a stage.');
      return { kind: 'stage', stage: obj };
    }
    if (obj && obj.format === 'rallyraid-roadbook') return { kind: 'roadbook', roadbook: obj, stage: null };
    if (parsed.kind === 'rally') {
      if (!obj || obj.format !== 'rallyraid-rally') throw new Error('This share link is not a rally.');
      return { kind: 'rally', rally: obj };
    }
    if (obj && obj.roadbook && obj.roadbook.format === 'rallyraid-roadbook') {
      return { kind: 'roadbook', roadbook: obj.roadbook, stage: obj.stage || null };
    }
    throw new Error('This share link is not a roadbook.');
  }

  function warnLevel(n) {
    if (n >= VERY) return 'very';
    if (n >= STRONG) return 'strong';
    if (n >= SOFT) return 'soft';
    return null;
  }
  function warnMessage(n) {
    var num = (n).toLocaleString ? n.toLocaleString() : String(n);
    if (n >= VERY) return 'This link is very long (' + num + ' characters). Many messaging apps and some phones will cut it, so the other person may not be able to open it. Email the link, or send the exported file instead.';
    if (n >= STRONG) return 'This link is long (' + num + ' characters). Many messaging apps will cut it. If you send it in a chat, check that the other person can open it, or send the exported file instead.';
    if (n >= SOFT) return 'This link is ' + num + ' characters. Some messaging apps (SMS, some chats) cut links around this length. If it does not open, send it by email or send the exported file.';
    return null;
  }

  function pageUrl(which) {
    if (typeof location === 'undefined') return which === 'roadbook' ? 'roadbook.html' : './';
    var origin = location.origin, path = location.pathname || '/';
    var onRb = /\/roadbook(\.html)?$/i.test(path);
    // Rally viewer is not public: there is no rally.html page to send people to.
    if (which === 'rally') {
      return origin + '/';
    }
    if (which === 'roadbook') {
      if (onRb) return origin + path;
      if (/index\.html$/i.test(path)) return origin + path.replace(/index\.html$/i, 'roadbook.html');
      return origin + (path.charAt(path.length - 1) === '/' ? path : path + '/') + 'roadbook.html';
    }
    if (onRb) {
      var dir = path.replace(/roadbook(\.html)?$/i, '');
      if (!dir) dir = '/';
      return origin + dir;
    }
    return origin + path;
  }

  function redirectIfNeeded(parsed) {
    if (!parsed || typeof location === 'undefined') return false;
    if (parsed.kind === 'short') return false; // resolved by resolveShort (the server already picked the page)
    var onRb = /roadbook(\.html)?$/i.test(location.pathname);
    var onRally = /rally(\.html)?$/i.test(location.pathname);
    var dest = null;
    if (parsed.kind === 'roadbook' && !onRb) dest = pageUrl('roadbook');
    if (parsed.kind === 'rally' && !onRally) dest = pageUrl('rally');
    if (parsed.kind === 'stage' && (onRb || onRally)) dest = pageUrl('stage');
    if (!dest) return false;
    location.replace(dest + location.hash);
    return true;
  }

  function linkFor(base, fragment) {
    var url = String(base || '').replace(/#.*$/, '') + '#' + fragment;
    return { url: url, length: url.length, warning: warnLevel(url.length), message: warnMessage(url.length) };
  }

  function clearHash() {
    if (typeof history === 'undefined' || typeof location === 'undefined') return;
    try {
      if (history.replaceState) history.replaceState(null, '', location.pathname + location.search);
      else location.hash = '';
    } catch (e) {}
  }

  function copyFallback(text) {
    return new Promise(function (res, rej) {
      if (typeof document === 'undefined') return rej(new Error('copy failed'));
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      try {
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) res(); else rej(new Error('copy failed'));
      } catch (e) {
        try { document.body.removeChild(ta); } catch (e2) {}
        rej(e);
      }
    });
  }
  function copyText(text) {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return copyFallback(text); });
    }
    return copyFallback(text);
  }

  var toastTimer = null;
  function ensureToastStyle() {
    if (typeof document === 'undefined' || document.getElementById('rr-share-toast-css')) return;
    var st = document.createElement('style');
    st.id = 'rr-share-toast-css';
    st.textContent = [
      '#rr-share-toast{position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:100000;',
      'max-width:min(560px,calc(100vw - 24px));background:#1c2026;color:#e8eaed;border:1px solid #3a414a;',
      'border-radius:6px;padding:10px 14px;font:13px/1.4 system-ui,Segoe UI,Roboto,sans-serif;',
      'box-shadow:0 8px 24px rgba(0,0,0,.45);display:none;pointer-events:none;}',
      '#rr-share-toast.warn{border-color:#a68b00;background:#2a2610;}',
      '#rr-share-toast.err{border-color:#8a2f2f;background:#2a1616;}',
      '#rr-share-toast.ok{border-color:#2f6b3a;}'
    ].join('');
    document.head.appendChild(st);
  }
  function toast(msg, kind, ms) {
    if (typeof document === 'undefined') return;
    ensureToastStyle();
    var el = document.getElementById('rr-share-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rr-share-toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.className = kind || 'ok';
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = 'none'; }, ms || (kind === 'warn' || kind === 'err' ? 9000 : 4500));
  }

  function isMobileShare() {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false;
    if (typeof matchMedia !== 'function') return true;
    return matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 900px)').matches;
  }

  function shareOrCopy(info, opts) {
    opts = opts || {};
    var title = opts.title || 'rally.raid Earth';
    var text = opts.text || title;
    var url = info.url;
    function afterCopy(extra) {
      var msg = extra || 'Link copied.';
      if (info.message) msg += ' ' + info.message;
      else msg += ' Anyone with the link can open it in their browser. Nothing is uploaded.';
      toast(msg, info.warning ? 'warn' : 'ok', info.warning ? 10000 : 4500);
    }
    if (info.warning === 'strong' || info.warning === 'very') {
      if (typeof confirm === 'function' && !confirm(info.message + '\n\nCopy or share the link anyway?')) {
        return Promise.resolve({ cancelled: true });
      }
    }
    if (isMobileShare()) {
      return navigator.share({ title: title, text: text, url: url }).then(function () {
        return { shared: true };
      }).catch(function (e) {
        if (e && e.name === 'AbortError') return { cancelled: true };
        // iOS share sheet can reject a very long url; try the link as text, then copy
        return navigator.share({ title: title, text: text + '\n' + url }).then(function () {
          return { shared: true, asText: true };
        }).catch(function (e2) {
          if (e2 && e2.name === 'AbortError') return { cancelled: true };
          return copyText(url).then(function () { afterCopy('The share sheet could not take this long link, so it was copied instead.'); return { copied: true, shareFailed: true }; });
        });
      });
    }
    return copyText(url).then(function () { afterCopy(); return { copied: true }; });
  }


  // ------------------------------------------------------------------ short links (/s/<id>)
  var SHORT_ID = /^[A-Za-z0-9]{22}$/;
  var SHORT_GONE = 'This short link was not found. It may be mistyped or cut off. Ask for a new link, or for the long link or file.';
  var SHORT_OFFLINE = 'Could not reach the site to open this short link. Check your connection and reload.';

  function apiBase() { return (typeof location !== 'undefined' && location.origin && /^https?:/.test(location.protocol)) ? location.origin : ''; }
  function canShort() { return !!apiBase() && typeof fetch === 'function' && !root.RR_NO_SHORT_LINKS; }

  // /s/<id> was served by the Worker with <meta name="rr-short">: switch the address to the page's own path + #k1=<id>
  // so every relative link, pageUrl() and a later share behave exactly as on the normal page.
  function adoptShortPath() {
    if (typeof document === 'undefined' || typeof location === 'undefined' || typeof history === 'undefined') return null;
    var m = /^\/s\/([A-Za-z0-9]{22})\/?$/.exec(location.pathname || '');
    var meta = document.querySelector && document.querySelector('meta[name="rr-short"]');
    if (!m || !meta) return null;
    var kind = meta.getAttribute('data-page');
    if (kind === 'rally') return null; // viewer retracted
    var page = kind === 'roadbook' ? '/roadbook.html' : '/';
    m = [m[0], m[1]];
    try { history.replaceState(null, '', page + '#k1=' + m[1]); } catch (e) { return null; }
    return m[1];
  }

  function fetchShort(id) {
    if (!SHORT_ID.test(id || '')) return Promise.reject(new Error(SHORT_GONE));
    return fetch(apiBase() + '/api/share/' + id, { headers: { accept: 'application/json' } }).then(function (r) {
      if (r.status === 404) throw new Error(SHORT_GONE);
      if (!r.ok) throw new Error(SHORT_OFFLINE + ' (HTTP ' + r.status + ')');
      return r.json();
    }, function () { throw new Error(SHORT_OFFLINE); }).then(function (rec) {
      if (!rec || (rec.kind !== 'stage' && rec.kind !== 'roadbook' && rec.kind !== 'rally') || typeof rec.data !== 'string') throw new Error(DAMAGED);
      return { kind: rec.kind, version: rec.v || 1, data: rec.data, shortId: id };
    });
  }

  /** parsed (from parseHash) -> Promise of a parsed long payload; for a short link of the other kind, sends the
   *  browser to the right page and resolves null. */
  function resolveShort(parsed) {
    if (!parsed || parsed.kind !== 'short') return Promise.resolve(parsed);
    if (parsed.version !== 1) return Promise.reject(new Error(NEWER));
    return fetchShort(parsed.id).then(function (p) {
      if (typeof location !== 'undefined') {
        var onRb = /roadbook(\.html)?$/i.test(location.pathname);
        var onRally = /rally(\.html)?$/i.test(location.pathname);
        var want = p.kind === 'roadbook' ? 'roadbook' : p.kind === 'rally' ? 'rally' : 'stage';
        var here = onRally ? 'rally' : onRb ? 'roadbook' : 'stage';
        if (want !== here) { location.replace(pageUrl(want) + '#k1=' + parsed.id); return null; }
      }
      return p;
    });
  }

  function createShort(fragment, timeoutMs) {
    if (!canShort()) return Promise.reject(new Error('short links need the website'));
    var m = /^(s|r|y)1=([A-Za-z0-9_-]+)$/.exec(fragment || '');
    if (!m) return Promise.reject(new Error('bad payload'));
    var kind = m[1] === 's' ? 'stage' : m[1] === 'r' ? 'roadbook' : 'rally';
    if (kind === 'rally') return Promise.reject(new Error('rally short links are not available'));
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 10000) : null;
    return fetch(apiBase() + '/api/share', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl ? ctl.signal : undefined,
      body: JSON.stringify({ v: 1, kind: kind, data: m[2] })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status !== 201 || !j || !SHORT_ID.test(j.id || '')) {
          var e = new Error((j && j.error) || ('the short link service answered HTTP ' + r.status)); e.status = r.status; throw e;
        }
        return apiBase() + '/s/' + j.id;
      });
    }, function (e) { throw new Error(e && e.name === 'AbortError' ? 'the short link service did not answer' : 'the short link service could not be reached'); })
      .then(function (u) { clearTimeout(timer); return u; }, function (e) { clearTimeout(timer); throw e; });
  }

  // copy a link that is still being made: ClipboardItem with a promise keeps Safari's user-gesture rule happy
  function copyLater(textPromise) {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem === 'function') {
      try {
        var item = new ClipboardItem({ 'text/plain': textPromise.then(function (t) { return new Blob([t], { type: 'text/plain' }); }) });
        return navigator.clipboard.write([item]).catch(function () { return textPromise.then(copyText); });
      } catch (e) {}
    }
    return textPromise.then(copyText);
  }

  // last resort when the clipboard or share sheet refuses (no user gesture left): show the link with its own buttons
  function showLinkBox(url, note) {
    if (typeof document === 'undefined') return;
    var old = document.getElementById('rr-linkbox'); if (old) old.remove();
    var box = document.createElement('div');
    box.id = 'rr-linkbox';
    box.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:12px';
    box.innerHTML = '<div style="background:#1c2026;color:#e8eaed;border:1px solid #3a414a;border-radius:8px;padding:14px;max-width:560px;width:100%;font:13px/1.4 system-ui,sans-serif">' +
      '<div class="lb-note" style="margin-bottom:8px"></div><input readonly style="width:100%;box-sizing:border-box;padding:6px;background:#0f1215;color:#e8eaed;border:1px solid #3a414a;border-radius:4px">' +
      '<div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end"><button type="button" data-a="share" style="display:none">Share</button><button type="button" data-a="copy">Copy</button><button type="button" data-a="close">Close</button></div></div>';
    box.querySelector('.lb-note').textContent = note || 'Here is your link:';
    var inp = box.querySelector('input'); inp.value = url;
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') box.querySelector('[data-a=share]').style.display = '';
    box.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-a');
      if (ev.target === box || a === 'close') box.remove();
      else if (a === 'copy') copyText(url).then(function () { toast('Link copied.', 'ok'); box.remove(); }, function () { inp.focus(); inp.select(); });
      else if (a === 'share') navigator.share({ url: url }).then(function () { box.remove(); }, function () {});
    });
    document.body.appendChild(box);
    inp.focus(); inp.select();
  }

  /** Share button: short link first, the long link automatically if that fails. page = 'stage' | 'roadbook'. */
  function shareLink(page, fragment, opts) {
    opts = opts || {};
    var long = linkFor(pageUrl(page), fragment);
    if (!canShort()) return shareOrCopy(long, opts);
    var title = opts.title || 'rally.raid Earth', text = opts.text || title;
    var made = createShort(fragment, opts.timeoutMs).then(function (u) { return { url: u, short: true }; },
      function (e) { return { url: long.url, short: false, reason: (e && e.message) || 'unknown error' }; });
    function note(r) {
      if (r.short) return 'Short link copied. Anyone with it can open this ' + (page === 'roadbook' ? 'roadbook' : page === 'rally' ? 'rally' : 'stage') + '; it is stored on rrearth.wyans.net. Use "Copy long link" for a link that carries the data itself.';
      return 'Could not make a short link (' + r.reason + '), so the long link was copied instead.' + (long.message ? ' ' + long.message : '');
    }
    if (isMobileShare()) {
      return made.then(function (r) {
        return navigator.share({ title: title, text: text, url: r.url }).then(function () { return { shared: true, short: r.short, url: r.url }; }, function (e) {
          if (e && e.name === 'AbortError') return { cancelled: true };
          showLinkBox(r.url, r.short ? 'Your short link:' : note(r));
          return { shown: true, short: r.short, url: r.url };
        });
      });
    }
    return copyLater(made.then(function (r) { return r.url; })).then(function () {
      return made.then(function (r) {
        toast(note(r), r.short ? 'ok' : 'warn', r.short ? 6000 : 10000);
        return { copied: true, short: r.short, url: r.url, reason: r.reason };
      });
    }, function () {
      return made.then(function (r) { showLinkBox(r.url, r.short ? 'Your short link:' : note(r)); return { shown: true, short: r.short, url: r.url }; });
    });
  }

  var adoptedShort = adoptShortPath();

  var api = {
    SOFT: SOFT, STRONG: STRONG, VERY: VERY, DAMAGED: DAMAGED, NEWER: NEWER,
    encodePayload: encodePayload, decodePayload: decodePayload,
    parseHash: parseHash, unpack: unpack, packStage: packStage, packRoadbook: packRoadbook, packRally: packRally,
    warnLevel: warnLevel, warnMessage: warnMessage, pageUrl: pageUrl, linkFor: linkFor,
    redirectIfNeeded: redirectIfNeeded, clearHash: clearHash,
    copyText: copyText, toast: toast, shareOrCopy: shareOrCopy, isMobileShare: isMobileShare,
    canShort: canShort, createShort: createShort, fetchShort: fetchShort, resolveShort: resolveShort,
    shareLink: shareLink, showLinkBox: showLinkBox, adoptedShort: adoptedShort, SHORT_GONE: SHORT_GONE
  };
  root.RallyRaidShare = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
