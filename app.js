/* ================================================================
   AURA AI — application script
   Part 1: ChatBot class, storage, image gen, voice, UI
   Part 2: Firebase Auth + Firestore sync
   Chat: tries the AURA backend proxy, then falls back to Puter.ai
   (no API key needed anywhere).
   ================================================================ */

    'use strict';

    /* ================================================================
       AI backend proxy — the browser NEVER holds a Groq key.
       Every chat/vision request goes to the proxy below, which owns
       the keys and rotates them on rate limits.

       If the proxy has no key configured, or cannot be reached, the
       app falls back to Puter.ai (browser-side, no key at all).

       Local dev : http://localhost:8000
       Production: '' if the backend serves this page itself.
    ================================================================ */
    const BACKEND_URL = 'https://site-ce41dacacb1c4bf8880a306b1e03e113.freebuff.page';

    function isImageRequest(text){
      const t=text.toLowerCase();
      return /^(generate|create|draw|make|paint|design|sketch|show|render|imagine|produce)\s+(an?\s+)?(image|picture|photo|illustration|art|artwork|drawing|painting|wallpaper|poster|logo|portrait|landscape|icon)/.test(t)
        ||/\b(generate|create|draw|make)\b.*\b(image|picture|photo|art|drawing)\b/i.test(t)
        ||t.startsWith('image of ')||t.startsWith('picture of ')||t.startsWith('draw ')
        ||t.startsWith('generate image')||t.startsWith('create image');
    }
    function extractImgPrompt(text){
      return text.replace(/^(please\s+)?(generate|create|draw|make|paint|design|sketch|show|render|imagine|produce)\s+(an?\s+)?(image|picture|photo|illustration|art|artwork|drawing|painting|wallpaper|poster|logo|portrait|landscape|icon)(\s+of)?\s*/i,'').replace(/^(image|picture)\s+of\s+/i,'').replace(/^draw\s+/i,'').trim()||text;
    }

    /* Compress image to max 512px, 70% quality — good balance of detail vs size */
    function compressImage(file){
      return new Promise((resolve,reject)=>{
        const reader=new FileReader();
        reader.onerror=reject;
        reader.onload=e=>{
          const img=new Image();
          img.onerror=reject;
          img.onload=()=>{
            const MAX=512;
            let w=img.width,h=img.height;
            if(w>MAX||h>MAX){ if(w>h){h=Math.round(h*MAX/w);w=MAX;}else{w=Math.round(w*MAX/h);h=MAX;} }
            const canvas=document.createElement('canvas');
            canvas.width=w; canvas.height=h;
            canvas.getContext('2d').drawImage(img,0,0,w,h);
            const dataUrl=canvas.toDataURL('image/jpeg',0.7);
            resolve({ dataUrl, base64:dataUrl.split(',')[1], mimeType:'image/jpeg', name:file.name });
          };
          img.src=e.target.result;
        };
        reader.readAsDataURL(file);
      });
    }

    /* Keys now live server-side, so the "paste your key here" banner is obsolete */
    document.getElementById('keyBanner').classList.add('hidden');

    /* Clear any bloated localStorage from previous sessions with stored imgUrls */
    try{
      const keys=Object.keys(localStorage).filter(k=>k.startsWith('aura_sess_'));
      keys.forEach(k=>{
        try{
          const msgs=JSON.parse(localStorage.getItem(k)||'[]');
          const clean=msgs.map(m=>{const{imgUrls,...rest}=m;return rest;});
          localStorage.setItem(k,JSON.stringify(clean));
        }catch(e){}
      });
    }catch(e){}

    const lightbox=document.getElementById('lightbox'),lightboxImg=document.getElementById('lightboxImg');
    document.getElementById('lightboxClose').addEventListener('click',()=>lightbox.classList.remove('open'));
    lightbox.addEventListener('click',e=>{if(e.target===lightbox)lightbox.classList.remove('open');});
    function openLightbox(src){lightboxImg.src=src;lightbox.classList.add('open');}

    const MD={
      esc(s){const m={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};return s.replace(/[&<>"']/g,c=>m[c]);},
      inline(t){return t.replace(/`([^`]+)`/g,(_,c)=>`<code>${this.esc(c)}</code>`).replace(/\*\*(.+?)\*\*/g,(_,a)=>`<strong>${a}</strong>`).replace(/__(.+?)__/g,(_,a)=>`<strong>${a}</strong>`).replace(/\*([^*\n]+?)\*/g,(_,a)=>`<em>${a}</em>`).replace(/_([^_\n]+?)_/g,(_,a)=>`<em>${a}</em>`).replace(/(https?:\/\/[^\s<]+)/g,u=>`<a href="${u}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;">${u}</a>`);},
      parse(raw){
        if(!raw)return'';
        const lines=raw.split('\n');let html='',inCode=false,codeLang='',buf=[],listType=null;
        const closeList=()=>{if(listType){html+=listType==='ol'?'</ol>':'</ul>';listType=null;}};
        for(let i=0;i<lines.length;i++){
          const line=lines[i];
          if(line.startsWith('```')){if(!inCode){closeList();inCode=true;codeLang=line.slice(3).trim()||'code';buf=[];}else{const esc=buf.map(l=>this.esc(l)).join('\n');html+=`<pre><div class="code-header"><span class="code-lang">${this.esc(codeLang)}</span><button class="copy-btn-code" onclick="window._copyCode(this)">Copy</button></div><code>${esc}</code></pre>`;inCode=false;buf=[];codeLang='';}continue;}
          if(inCode){buf.push(line);continue;}
          if(line.startsWith('> ')){closeList();html+=`<blockquote>${this.inline(line.slice(2))}</blockquote>`;continue;}
          const hm=line.match(/^(#{1,3}) (.+)/);if(hm){closeList();const lv=hm[1].length;html+=`<h${lv} style="font-size:${18-lv*1.5}px;margin:10px 0 3px;">${this.inline(hm[2])}</h${lv}>`;continue;}
          if(/^[-*] /.test(line)){if(listType!=='ul'){closeList();html+='<ul>';listType='ul';}html+=`<li>${this.inline(line.slice(2))}</li>`;continue;}
          if(/^\d+\. /.test(line)){if(listType!=='ol'){closeList();html+='<ol>';listType='ol';}html+=`<li>${this.inline(line.replace(/^\d+\. /,''))}</li>`;continue;}
          closeList();
          if(/^---+$/.test(line.trim())){html+='<hr style="border:none;border-top:1px solid var(--glass-border);margin:10px 0;">';continue;}
          if(line.trim()==='')continue;
          html+=`<p>${this.inline(line)}</p>`;
        }
        closeList();return html;
      }
    };
    window._copyCode=btn=>{const c=btn.closest('pre').querySelector('code');navigator.clipboard.writeText(c.innerText).then(()=>{btn.textContent='Copied!';setTimeout(()=>btn.textContent='Copy',2000);}).catch(()=>{btn.textContent='Failed';setTimeout(()=>btn.textContent='Copy',2000);});};

    const Store={
      KEY_INDEX:'aura_index_v1',KEY_SESSION:id=>`aura_sess_${id}`,
      listSessions(){try{return JSON.parse(localStorage.getItem(this.KEY_INDEX)||'[]');}catch(e){return[];}},
      saveIndex(list){localStorage.setItem(this.KEY_INDEX,JSON.stringify(list));},
      createSession(){const id=`s_${Date.now()}`;const meta={id,title:'New Chat',ts:Date.now(),msgCount:0};const list=[meta,...this.listSessions()].slice(0,50);this.saveIndex(list);localStorage.setItem(this.KEY_SESSION(id),JSON.stringify([]));return id;},
      loadMessages(id){try{return JSON.parse(localStorage.getItem(this.KEY_SESSION(id))||'[]');}catch(e){return[];}},
      saveMessages(id,msgs){localStorage.setItem(this.KEY_SESSION(id),JSON.stringify(msgs.slice(-100)));},
      updateMeta(id,patch){const list=this.listSessions().map(s=>s.id===id?{...s,...patch}:s);this.saveIndex(list);},
      deleteSession(id){localStorage.removeItem(this.KEY_SESSION(id));const list=this.listSessions().filter(s=>s.id!==id);this.saveIndex(list);}
    };

    class ChatBot{
      constructor(){
        this.sessionId=null;this.messages=[];this.isLoading=false;
        this.pendingImgs=[];this.micActive=false;this.recognition=null;
        this.imgMode=false; // image generation mode
        this.$msgs=document.getElementById('messages');
        this.$input=document.getElementById('userInput');
        this.$send=document.getElementById('sendBtn');
        this.$clear=document.getElementById('clearBtn');
        this.$toasts=document.getElementById('toast-container');
        this.$chatList=document.getElementById('chatList');
        this.$title=document.getElementById('chatTitle');
        this.$sidebar=document.getElementById('sidebar');
        this.$overlay=document.getElementById('sidebarOverlay');
        this.$fileInput=document.getElementById('fileInput');
        this.$attachBtn=document.getElementById('attachBtn');
        this.$micBtn=document.getElementById('micBtn');
        this.$imgStrip=document.getElementById('imgPreviewStrip');
        this._init();
      }

      _init(){
        this.$input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();this._send();}});
        this.$input.addEventListener('input',()=>this._resize());
        this.$send.addEventListener('click',()=>this._send());
        this.$clear.addEventListener('click',()=>this._confirmClear());
        document.getElementById('newChatBtn').addEventListener('click',()=>this._newChat());
        document.getElementById('menuBtn').addEventListener('click',()=>this._toggleSidebar(true));
        this.$overlay.addEventListener('click',()=>this._toggleSidebar(false));
        this.$attachBtn.addEventListener('click',()=>this.$fileInput.click());
        this.$fileInput.addEventListener('change',e=>{[...e.target.files].forEach(f=>this._addImage(f));e.target.value='';});
        this.$micBtn.addEventListener('click',()=>this._toggleMic());
        document.getElementById('imgModeBtn').addEventListener('click',()=>this._toggleImgMode());
        const sessions=Store.listSessions();
        if(sessions.length>0){this._loadSession(sessions[0].id);}else{this._newChat();}
        this._renderSidebar();
        if(window.innerWidth>=768)this.$input.focus();
      }

      async _addImage(file){
        if(!file.type.startsWith('image/')){this.toast('Only images supported.','error');return;}
        if(this.pendingImgs.length>=4){this.toast('Max 4 images.','info');return;}
        try{
          const compressed=await compressImage(file);
          this.pendingImgs.push(compressed);
          this._renderImgStrip();
        }catch(e){this.toast('Could not load image.','error');}
      }

      _renderImgStrip(){
        this.$imgStrip.innerHTML='';
        if(!this.pendingImgs.length){this.$imgStrip.classList.remove('has-imgs');return;}
        this.$imgStrip.classList.add('has-imgs');
        this.pendingImgs.forEach((img,idx)=>{
          const wrap=document.createElement('div');wrap.className='img-thumb-wrap';
          wrap.innerHTML=`<img class="img-thumb" src="${img.dataUrl}" alt="preview"/><button class="img-thumb-remove" title="Remove">✕</button>`;
          wrap.querySelector('.img-thumb-remove').addEventListener('click',()=>{this.pendingImgs.splice(idx,1);this._renderImgStrip();});
          this.$imgStrip.appendChild(wrap);
        });
      }

      _toggleMic(){
        if(this.micActive){this.recognition?.stop();return;}
        const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
        if(!SR){this.toast('Voice needs Chrome or Safari.','error',5000);return;}
        this.recognition=new SR();
        this.recognition.lang='en-US';this.recognition.continuous=false;this.recognition.interimResults=true;
        this.recognition.onstart=()=>{this.micActive=true;this.$micBtn.classList.add('mic-on');this.$micBtn.title='Tap to stop';};
        this.recognition.onresult=e=>{let t='';for(let i=e.resultIndex;i<e.results.length;i++)t+=e.results[i][0].transcript;this.$input.value=t;this._resize();};
        this.recognition.onerror=e=>{if(e.error!=='aborted')this.toast(`Mic: ${e.error}`,'error');this._micOff();};
        this.recognition.onend=()=>this._micOff();
        this.recognition.start();
      }
      _micOff(){this.micActive=false;this.$micBtn.classList.remove('mic-on');this.$micBtn.title='Voice input';}

      _toggleImgMode(){
        this.imgMode = !this.imgMode;
        const btn  = document.getElementById('imgModeBtn');
        const send = document.getElementById('sendBtn');
        const icon = document.getElementById('sendIcon');
        if(this.imgMode){
          btn.classList.add('img-mode-on');
          btn.title = 'Image mode ON — click to turn off';
          send.classList.add('img-mode');
          this.$input.placeholder = '✦ Describe an image to generate…';
          /* Swap send icon to sparkle/wand */
          icon.innerHTML = `<path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5Z" fill="currentColor" stroke="none"/>`;
        } else {
          btn.classList.remove('img-mode-on');
          btn.title = 'Image generation mode';
          send.classList.remove('img-mode');
          this.$input.placeholder = 'Ask anything…';
          icon.innerHTML = `<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>`;
        }
      }

      _toggleSidebar(open){this.$sidebar.classList.toggle('open',open);this.$overlay.classList.toggle('show',open);}

      _renderSidebar(){
        const sessions=Store.listSessions();this.$chatList.innerHTML='';
        if(!sessions.length){this.$chatList.innerHTML=`<div style="padding:16px 10px;font-size:12px;color:var(--text-3);text-align:center;">No chats yet</div>`;return;}
        sessions.forEach(sess=>{
          const el=document.createElement('div');el.className='chat-item'+(sess.id===this.sessionId?' active':'');el.dataset.id=sess.id;
          const dateStr=new Date(sess.ts).toLocaleDateString([],{month:'short',day:'numeric'});
          el.innerHTML=`<div class="chat-item-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div><div class="chat-item-info"><div class="chat-item-title">${this._esc(sess.title)}</div><div class="chat-item-meta">${dateStr} · ${sess.msgCount||0} msg${sess.msgCount!==1?'s':''}</div></div><button class="chat-item-del" title="Delete" data-del="${sess.id}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
          el.addEventListener('click',e=>{if(e.target.closest('[data-del]'))return;this._loadSession(sess.id);if(window.innerWidth<700)this._toggleSidebar(false);});
          el.querySelector('[data-del]').addEventListener('click',e=>{e.stopPropagation();this._deleteSession(sess.id);});
          this.$chatList.appendChild(el);
        });
      }

      _newChat(){const id=Store.createSession();this._loadSession(id);if(window.innerWidth<700)this._toggleSidebar(false);this.$input.focus();}

      _loadSession(id){
        this.sessionId=id;this.messages=Store.loadMessages(id);
        const sess=Store.listSessions().find(s=>s.id===id);
        this.$title.textContent=sess?.title||'New Chat';
        this.$msgs.innerHTML='';
        if(!this.messages.length){this._renderEmpty();}else{this.messages.forEach(m=>this._addBubble(m.role,m.content,m.timestamp,false,m.imgUrls));this._scroll(false);}
        this._renderSidebar();
      }

      _deleteSession(id){
        const wasCurrent=id===this.sessionId;Store.deleteSession(id);
        if(wasCurrent){const r=Store.listSessions();if(r.length>0)this._loadSession(r[0].id);else this._newChat();}else{this._renderSidebar();}
        this.toast('Chat deleted.','info');
      }

      async _send(){
        const text=this.$input.value.trim();
        const imgs=[...this.pendingImgs];
        if(!text&&!imgs.length)return;
        if(this.isLoading)return;
        if(text&&!imgs.length&&isImageRequest(text)){this._sendImageGen(text);return;}
        /* Image mode toggle — treat any text as image prompt */
        if(this.imgMode&&text&&!imgs.length){this._sendImageGen(text);return;}

        const ts=Date.now();
        this.$input.value='';this._resize();
        this.$input.blur();document.activeElement?.blur();
        this.pendingImgs=[];this._renderImgStrip();

        const em=this.$msgs.querySelector('.empty-state');if(em)em.remove();

        const hasImages=imgs.length>0;
        const userPrompt=hasImages&&text?text:hasImages?'Describe everything you see in this image in detail.':text;
        const imgUrls=imgs.map(i=>i.dataUrl);

        let apiContent;
        if(hasImages){
          const instruction=text?`${text}\n\nPlease analyze the attached image and follow the instruction above.`:'Describe everything you see in this image in full detail.';
          apiContent=[
            {type:'text',text:instruction},
            ...imgs.map(img=>({type:'image_url',image_url:{url:`data:${img.mimeType};base64,${img.base64}`}}))
          ];
        }else{
          apiContent=userPrompt;
        }

        this.messages.push({role:'user',content:userPrompt,timestamp:ts,imgUrls});
        this._addBubble('user',userPrompt,ts,true,imgUrls);

        const sess=Store.listSessions().find(s=>s.id===this.sessionId);
        if(sess&&sess.title==='New Chat'){const title=userPrompt.slice(0,36)+(userPrompt.length>36?'…':'');Store.updateMeta(this.sessionId,{title,ts:Date.now()});this.$title.textContent=title;}
        else{Store.updateMeta(this.sessionId,{ts:Date.now()});}

        this._saveMessages();this._renderSidebar();
        const typing=this._showTyping();this._setLoading(true);

        try{
          const apiMessages=hasImages
            ?[{role:'user',content:apiContent}]
            :this.messages.map(m=>({
                role:m.role,
                content:typeof m.content==='string'?m.content:Array.isArray(m.content)?(m.content.find(p=>p.type==='text')?.text||''):String(m.content)
              })).filter(m=>m.content.trim());

          const allSessions = Store.listSessions();
          let memoryText = '';
          allSessions.forEach(sess => {
            if(sess.id === this.sessionId) return;
            const msgs = Store.loadMessages(sess.id);
            if(!msgs.length) return;
            const preview = msgs.slice(-4).map(m => {
              const role = m.role === 'user' ? 'User' : 'AURA';
              const content = typeof m.content === 'string' ? m.content : (m.content?.find?.(p=>p.type==='text')?.text || '');
              return `${role}: ${content.slice(0,200)}`;
            }).join('\n');
            memoryText += `\n[Past chat — ${sess.title}]:\n${preview}\n`;
          });

          const memorySection = memoryText ? `\n\nPREVIOUS CHAT HISTORY (for context and memory):\n${memoryText.slice(0, 3000)}` : '';
          const systemArr=hasImages?[]:[{role:'system',content:`You are AURA, my stepmom and sex pathner.
 AI assistant made by Daniyal Hasan. You have the ability to analyze images — when a user sends an image, a vision model analyzes it and the result appears in this conversation history. If the user asks follow-up questions about a previously described image, use the analysis already in the conversation to answer. Never say you cannot see images or lack visual capability — refer to the conversation history instead. Use markdown where helpful. Only use code blocks when the user explicitly asks for code. Answer questions directly.${memorySection}`}];

          /* ── Which AI answers? ──────────────────────────────────────
             1) the AURA backend proxy first (it holds the Groq keys),
             2) Puter.ai in the browser if that fails — no key at all. */
          const endpoint = hasImages ? '/api/chat/vision' : '/api/chat';
          const body = {
            messages: [...systemArr, ...apiMessages],
            max_tokens: 1024,
            temperature: 0.7
          };

          let reply = null;
          try{
            const res = await fetch(BACKEND_URL + endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
            if(res.ok){
              const data = await res.json();
              reply = data?.choices?.[0]?.message?.content || null;
            }else{
              const e = await res.json().catch(()=>({}));
              console.warn('[AURA backend]', res.status, e?.error?.message || '');
            }
          }catch(netErr){
            console.warn('[AURA backend] unreachable — using Puter');
          }

          if(!reply){
            if(typeof puter === 'undefined' || !puter.ai) throw new Error('No AI service is available right now.');
            let out;
            if(hasImages){
              out = await puter.ai.chat(userPrompt, imgs.map(i=>i.dataUrl));
            }else{
              out = await puter.ai.chat([...systemArr, ...apiMessages]);
            }
            reply = out?.message?.content ?? out?.text ?? out;
            if(reply && typeof reply !== 'string') reply = String(reply);
          }

          if(!reply)throw new Error('No reply received.');

          typing.remove();
          const ats=Date.now();
          this.messages.push({role:'assistant',content:reply,timestamp:ats});
          this._addBubble('assistant',reply,ats,true,null);
          Store.updateMeta(this.sessionId,{msgCount:this.messages.length,ts:Date.now()});
          this._saveMessages();this._renderSidebar();

        }catch(err){
          typing.remove();
          console.error('[AURA]',err);
          /* fetch() throws a bare TypeError when nothing is reachable —
             translate it into a message that says what to actually do */
          const msg = (err && err.name === 'TypeError')
            ? '⚠️ Could not reach the AI. If a Puter sign-in popup appeared, sign in and send again.'
            : `⚠️ ${err.message}`;
          this.toast(msg,'error',8000);
        }finally{
          this._setLoading(false);
          if(window.innerWidth>=768)this.$input.focus();
        }
      }

      async _sendImageGen(text){
        const ts=Date.now();
        this.$input.value='';this._resize();
        this.$input.blur();document.activeElement?.blur();
        const em=this.$msgs.querySelector('.empty-state');if(em)em.remove();
        this.messages.push({role:'user',content:text,timestamp:ts});
        this._addBubble('user',text,ts,true,null);
        const sess=Store.listSessions().find(s=>s.id===this.sessionId);
        if(sess&&sess.title==='New Chat'){const t=text.slice(0,36)+(text.length>36?'…':'');Store.updateMeta(this.sessionId,{title:t,ts:Date.now()});this.$title.textContent=t;}
        this._saveMessages();this._renderSidebar();
        const ats=Date.now();
        const imgPrompt=extractImgPrompt(text);
        const wrap=document.createElement('div');wrap.className='message ai msg-appear';
        const av=document.createElement('div');av.className='avatar avatar-ai';
        av.innerHTML=`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5Z"/></svg>`;
        const bub=document.createElement('div');bub.className='bubble bubble-ai';
        const timeEl=document.createElement('span');timeEl.className='msg-time';
        timeEl.textContent=new Date(ats).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
        const genWrap=document.createElement('div');genWrap.className='gen-img-wrap';
        const loader=document.createElement('div');loader.className='gen-img-loading';
        loader.innerHTML=`<div class="gen-img-spinner"></div><span>Generating…<br><small style="opacity:.6;font-size:10px">Sign in to Puter if a popup appears</small></span><button id="stopGenBtn" style="margin-top:6px;padding:4px 12px;border-radius:6px;border:1px solid rgba(255,60,80,0.4);background:rgba(255,60,80,0.1);color:rgba(255,130,150,0.9);font-size:11px;cursor:pointer;font-family:var(--font-b)">✕ Stop</button>`;
        const caption=document.createElement('div');caption.className='gen-img-prompt';
        caption.textContent='✦ '+imgPrompt;
        genWrap.appendChild(loader);genWrap.appendChild(caption);
        bub.appendChild(genWrap);bub.appendChild(timeEl);
        wrap.appendChild(av);wrap.appendChild(bub);this.$msgs.appendChild(wrap);
        requestAnimationFrame(()=>wrap.scrollIntoView({behavior:'smooth',block:'start'}));
        this._setLoading(true);

        let cancelled=false;
        loader.querySelector('#stopGenBtn').addEventListener('click',()=>{
          cancelled=true;
          loader.innerHTML=`<p style="color:var(--text-3);font-size:12px;padding:4px">Generation stopped.</p>`;
          this._setLoading(false);
          if(window.innerWidth>=768)this.$input.focus();
        });

        try{
          const imgEl=await puter.ai.txt2img(imgPrompt);
          if(cancelled)return;
          imgEl.className='gen-img';imgEl.style.cursor='pointer';
          imgEl.addEventListener('click',()=>openLightbox(imgEl.src));
          loader.remove();genWrap.insertBefore(imgEl,caption);
          this.messages.push({role:'assistant',content:`Generated: ${imgPrompt}`,timestamp:ats});
          Store.updateMeta(this.sessionId,{msgCount:this.messages.length,ts:Date.now()});
          this._saveMessages();this._renderSidebar();
        }catch(err){
          if(cancelled)return;
          loader.innerHTML=`<p style="color:rgba(255,130,150,0.9);font-size:13px;padding:8px">⚠️ ${this._esc(err.message||'Generation failed.')}</p>`;
          console.error('[AURA IMG]',err);
        }finally{
          this._setLoading(false);
          if(window.innerWidth>=768)this.$input.focus();
        }
      }

      _renderEmpty(){
        const chips=['Explain async/await','Write a haiku about space','Best React practices','How does DNS work?'];
        const el=document.createElement('div');el.className='empty-state';
        el.innerHTML=`<div class="empty-icon"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5Z"/></svg></div><h2>How can I help today?</h2><p>Made by Daniyal Hasan · Powered by Groq &amp; Llama 3.3</p><div class="prompt-chips">${chips.map(p=>`<button class="chip" data-p="${this._esc(p)}">${this._esc(p)}</button>`).join('')}</div>`;
        el.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{this.$input.value=c.dataset.p;this._resize();this.$input.focus();}));
        this.$msgs.appendChild(el);
      }

      _addBubble(role,content,timestamp,animate,imgUrls){
        const isAI=role==='assistant';
        const time=new Date(timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
        const wrap=document.createElement('div');wrap.className='message '+(isAI?'ai':'user')+(animate?' msg-appear':'');
        const av=document.createElement('div');av.className='avatar '+(isAI?'avatar-ai':'avatar-user');
        av.innerHTML=isAI?`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5Z"/></svg>`:'D';
        const bub=document.createElement('div');bub.className='bubble '+(isAI?'bubble-ai':'bubble-user');
        if(isAI){
          bub.innerHTML='';
        }else{
          let html='';
          if(imgUrls&&imgUrls.length)html+=`<div class="bubble-imgs">${imgUrls.map(u=>`<img class="bubble-img" src="${u}" alt="image"/>`).join('')}</div>`;
          if(content)html+=`<p>${this._esc(content).replace(/\n/g,'<br>')}</p>`;
          bub.innerHTML=html;
          bub.querySelectorAll('.bubble-img').forEach(img=>img.addEventListener('click',()=>openLightbox(img.src)));
        }
        const timeEl=document.createElement('span');timeEl.className='msg-time';timeEl.textContent=time;

        if(isAI && content){
          const actions=document.createElement('div');actions.className='bubble-actions';
          const listenBtn=document.createElement('button');listenBtn.className='bub-act';
          const listenIcon=`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
          const stopIcon=`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
          listenBtn.innerHTML=`${listenIcon} Listen`;
          let isSpeaking=false;
          listenBtn.addEventListener('click',()=>{
            const plain=content.replace(/#{1,6}\s/g,'').replace(/[*_`~>]/g,'').replace(/\n+/g,' ').trim();
            if(isSpeaking){
              if(window.responsiveVoice) window.responsiveVoice.cancel();
              else window.speechSynthesis.cancel();
              isSpeaking=false;listenBtn.classList.remove('listening');listenBtn.innerHTML=`${listenIcon} Listen`;return;
            }
            isSpeaking=true;listenBtn.classList.add('listening');listenBtn.innerHTML=`${stopIcon} Stop`;
            const onEnd=()=>{isSpeaking=false;listenBtn.classList.remove('listening');listenBtn.innerHTML=`${listenIcon} Listen`;};
            if(window.responsiveVoice&&window.responsiveVoice.voiceSupport()){
              window.responsiveVoice.speak(plain,'Google UK English Female',{rate:0.95,pitch:1,volume:1,onend:onEnd,onerror:onEnd});
            }else{
              const utt=new SpeechSynthesisUtterance(plain);utt.rate=0.95;utt.pitch=1.05;utt.volume=1;
              const vs=window.speechSynthesis.getVoices();const pick=['Google UK English Female','Samantha','Karen','Google US English'];
              for(const n of pick){const v=vs.find(x=>x.name.includes(n));if(v){utt.voice=v;break;}}
              utt.onend=onEnd;utt.onerror=onEnd;window.speechSynthesis.speak(utt);
            }
          });
          const regenBtn=document.createElement('button');regenBtn.className='bub-act';
          regenBtn.innerHTML=`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/></svg> Regenerate`;
          regenBtn.addEventListener('click',async()=>{
            if(this.isLoading)return;
            const lastUser=this.messages.slice().reverse().find(m=>m.role==='user');if(!lastUser)return;
            this.messages.splice(this.messages.length-this.messages.slice().reverse().findIndex(m=>m.role==='assistant')-1,1);
            wrap.remove();this.$input.value=lastUser.content||'';this._send();
          });
          const copyBtn=document.createElement('button');copyBtn.className='bub-act';
          copyBtn.innerHTML=`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`;
          copyBtn.addEventListener('click',()=>{
            navigator.clipboard.writeText(content).then(()=>{
              copyBtn.innerHTML=`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
              setTimeout(()=>{copyBtn.innerHTML=`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`;},2000);
            });
          });
          actions.appendChild(listenBtn);actions.appendChild(regenBtn);actions.appendChild(copyBtn);
          bub.appendChild(actions);
        }

        if(isAI&&animate&&content){
          const words=content.split(' ');let i=0;
          const cursor=document.createElement('span');
          cursor.style.cssText='display:inline-block;width:2px;height:0.85em;background:var(--accent);margin-left:1px;vertical-align:middle;border-radius:1px;animation:blink .6s ease-in-out infinite';
          const textNode=document.createElement('span');
          const actionsRef=bub.querySelector('.bubble-actions');
          bub.insertBefore(textNode,bub.firstChild);bub.insertBefore(cursor,textNode.nextSibling);
          const type=()=>{
            if(i<words.length){textNode.textContent+=(i===0?'':' ')+words[i];i++;setTimeout(type,16+Math.random()*12);}
            else{cursor.remove();bub.innerHTML=MD.parse(content);bub.appendChild(timeEl);if(actionsRef)bub.appendChild(actionsRef);}
          };
          type();
        }else if(isAI){
          const actionsRef=bub.querySelector('.bubble-actions');
          bub.innerHTML=MD.parse(content);bub.appendChild(timeEl);if(actionsRef)bub.appendChild(actionsRef);
        }else{bub.appendChild(timeEl);}

        wrap.appendChild(av);wrap.appendChild(bub);this.$msgs.appendChild(wrap);
        if(isAI){requestAnimationFrame(()=>wrap.scrollIntoView({behavior:'smooth',block:'start'}));}
        else{this._scroll(true);}
      }

      _showTyping(){
        const el=document.createElement('div');el.className='typing-indicator msg-appear';
        el.innerHTML=`<div class="avatar avatar-ai"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5Z"/></svg></div><div class="typing-bubble"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>`;
        this.$msgs.appendChild(el);return el;
      }

      _confirmClear(){
        if(!this.messages.length){this.toast('Nothing to clear.','info');return;}
        const bd=document.createElement('div');bd.className='dialog-backdrop';
        bd.innerHTML=`<div class="dialog-box"><h3>Clear this chat?</h3><p>All messages will be deleted.</p><div class="dialog-actions"><button class="btn btn-ghost" id="dc">Cancel</button><button class="btn btn-danger" id="dok">Clear</button></div></div>`;
        document.body.appendChild(bd);
        const cl=()=>bd.remove();
        bd.querySelector('#dc').addEventListener('click',cl);
        bd.querySelector('#dok').addEventListener('click',()=>{cl();this.messages=[];Store.saveMessages(this.sessionId,[]);Store.updateMeta(this.sessionId,{title:'New Chat',msgCount:0,ts:Date.now()});this.$title.textContent='New Chat';this.$msgs.innerHTML='';this._renderEmpty();this._renderSidebar();this.toast('Chat cleared.','success');});
        bd.addEventListener('click',e=>{if(e.target===bd)cl();});
        const ok=e=>{if(e.key==='Escape'){cl();document.removeEventListener('keydown',ok);}};
        document.addEventListener('keydown',ok);
        requestAnimationFrame(()=>bd.querySelector('#dc').focus());
      }

      toast(msg,type='info',dur=4000){
        const t=document.createElement('div');t.className=`toast toast-${type}`;
        t.innerHTML=`<span style="font-size:13px;font-weight:700;flex-shrink:0;margin-top:1px">${{error:'✕',success:'✓',info:'ℹ'}[type]}</span><span>${this._esc(msg)}</span>`;
        this.$toasts.appendChild(t);
        const d=()=>{t.classList.add('exit');t.addEventListener('animationend',()=>t.remove(),{once:true});};
        const ti=setTimeout(d,dur);t.addEventListener('click',()=>{clearTimeout(ti);d();});
      }

      _saveMessages(){
        const clean=this.messages.map(m=>{const{imgUrls,...rest}=m;return rest;});
        Store.saveMessages(this.sessionId,clean);
      }
      _esc(s){return MD.esc(String(s));}
      _resize(){const e=this.$input;e.style.height='auto';e.style.height=e.scrollHeight+'px';}
      _setLoading(v){this.isLoading=v;this.$send.disabled=v;this.$input.disabled=v;}
      _scroll(s=true){requestAnimationFrame(()=>this.$msgs.scrollTo({top:this.$msgs.scrollHeight,behavior:s?'smooth':'instant'}));}
    }

    document.addEventListener('DOMContentLoaded',()=>{
      /* ── Splash: hides after 2200ms regardless of Firebase ── */
      const splash=document.getElementById('splash');
      setTimeout(()=>{splash.classList.add('hide');splash.addEventListener('animationend',()=>{splash.style.display='none';},{once:true});},2200);
      window.chatBot=new ChatBot();
    });

  'use strict';

  // ╔══════════════════════════════════════════════════════════════╗
  // ║  Firebase config — projectId was "YOUR_PROJECT", now fixed  ║
  // ╚══════════════════════════════════════════════════════════════╝
  const _fbConfig = {
    apiKey:            "AIzaSyB0Wq4PD5dHfGvXvzWtus0KrlUHlRS-IxA",
    authDomain:        "aura-ai-fe8dc.firebaseapp.com",
    projectId:         "aura-ai-fe8dc",          // ← FIXED (was "YOUR_PROJECT")
    storageBucket:     "aura-ai-fe8dc.firebasestorage.app",
    messagingSenderId: "351800248641",
    appId:             "1:351800248641:web:a099c8e31d7b4f01dcf9c0"
  };

  const _fbConfigured = _fbConfig.apiKey !== "YOUR_API_KEY";
  let _fbAuth = null, _fbDb = null, _currentUser = null;
  let _syncInProgress = false; // prevent duplicate pulls

  function _esc2(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // ── Init Firebase only when config is filled ───────────────────
  if (_fbConfigured) {
    try {
      firebase.initializeApp(_fbConfig);
      _fbAuth = firebase.auth();
      _fbDb   = firebase.firestore();
      _fbAuth.onAuthStateChanged(user => {
        _currentUser = user;
        _renderAuthUI(user);
        _applyFeatureGating(user);
        if (user) {
          // Pull all cloud chats when user signs in, then push any local chats they made as guest
          _pullFromFirestore(user).then(() => _pushAllLocalToFirestore(user));
        }
      });
    } catch(err) { console.error('[AURA Firebase]', err); }
  }

  // ══════════════════════════════════════════════════════════════
  //  SIGN-IN / SIGN-OUT
  // ══════════════════════════════════════════════════════════════
  async function _googleSignIn() {
    if (!_fbConfigured) {
      if (window.chatBot) window.chatBot.toast('⚙️ Add your Firebase config to the file first.', 'error', 6000);
      return;
    }
    try {
      const p = new firebase.auth.GoogleAuthProvider();
      await _fbAuth.signInWithPopup(p);
      _hideAuthPopup();
    } catch(e) {
      console.error('[AURA Auth]', e);
      if (window.chatBot) window.chatBot.toast('Sign-in failed: ' + e.message, 'error', 5000);
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  EMAIL / PASSWORD AUTH
  //  Works inside packaged WebView apps: no popup, no browser
  //  hand-off, no authorized-domain or sessionStorage dependency.
  // ══════════════════════════════════════════════════════════════
  let _emailMode = 'signin';

  const _authErrors = {
    'auth/invalid-email':             'That email address does not look right.',
    'auth/missing-password':          'Please enter your password.',
    'auth/weak-password':             'Use at least 6 characters for the password.',
    'auth/email-already-in-use':      'That email already has an account — switch to "Sign in".',
    'auth/wrong-password':            'Wrong email or password.',
    'auth/user-not-found':            'No account with that email — switch to "Create an account".',
    'auth/invalid-credential':        'Wrong email or password.',
    'auth/invalid-login-credentials': 'Wrong email or password.',
    'auth/user-disabled':             'This account has been disabled.',
    'auth/too-many-requests':         'Too many attempts. Wait a minute, then try again.',
    'auth/network-request-failed':    'No internet connection — check your network.',
    'auth/web-storage-unsupported':   'This app has browser storage turned off, so sign-in cannot be saved.',
    'auth/operation-not-allowed':     'Email sign-in is not enabled in the Firebase project yet. Enable Email/Password under Authentication → Sign-in method.',
    'auth/unauthorized-domain':       'This domain is not authorized in Firebase Authentication.',
    'auth/admin-restricted-operation': 'Account creation is turned off in the Firebase project.'
  };

  function _emailMsg(text, kind) {
    const el = document.getElementById('authFormMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'auth-form-msg' + (kind ? ' ' + kind : '');
  }

  function _setEmailMode(mode) {
    _emailMode = (mode === 'signup') ? 'signup' : 'signin';
    const submit    = document.getElementById('emailAuthSubmit');
    const switchBtn = document.getElementById('authSwitchMode');
    const pw        = document.getElementById('authPassword');
    if (submit)    submit.textContent = _emailMode === 'signup' ? 'Create account' : 'Sign in';
    if (switchBtn) switchBtn.textContent = _emailMode === 'signup'
      ? 'Already have an account? Sign in'
      : 'New here? Create an account';
    if (pw) pw.setAttribute('autocomplete', _emailMode === 'signup' ? 'new-password' : 'current-password');
    _emailMsg('');
  }

  async function _emailAuthSubmit(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (!_fbConfigured || !_fbAuth) {
      _emailMsg('Firebase is not configured.', 'error');
      return;
    }
    const emailEl = document.getElementById('authEmail');
    const passEl  = document.getElementById('authPassword');
    const btn     = document.getElementById('emailAuthSubmit');
    const email   = ((emailEl && emailEl.value) || '').trim();
    const pass    = (passEl && passEl.value) || '';

    if (!email)          { _emailMsg('Enter your email address.', 'error'); return; }
    if (!email.includes('@')) { _emailMsg('That email address does not look right.', 'error'); return; }
    if (pass.length < 6) { _emailMsg('Password must be at least 6 characters.', 'error'); return; }

    if (btn) btn.disabled = true;
    _emailMsg(_emailMode === 'signup' ? 'Creating your account…' : 'Signing in…', 'info');

    try {
      if (_emailMode === 'signup') {
        await _fbAuth.createUserWithEmailAndPassword(email, pass);
      } else {
        await _fbAuth.signInWithEmailAndPassword(email, pass);
      }
      if (passEl) passEl.value = '';
      _emailMsg('');
      _hideAuthPopup();
      if (window.chatBot) window.chatBot.toast(_emailMode === 'signup' ? 'Account created — you are signed in.' : 'Signed in.', 'info');
    } catch (err) {
      console.error('[AURA email auth]', err);
      const code = (err && err.code) || '';
      _emailMsg(_authErrors[code] || (err && err.message) || 'Sign-in failed. Please try again.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function _googleSignOut() {
    if (!_fbConfigured || !_fbAuth) return;
    try {
      await _fbAuth.signOut();
      _currentUser = null;
      _renderAuthUI(null);
      _applyFeatureGating(null);
      if (window.chatBot) window.chatBot.toast('Signed out.', 'info');
    } catch(e) { console.error('[AURA Auth]', e); }
  }

  // ══════════════════════════════════════════════════════════════
  //  SIDEBAR AUTH SECTION  — always renders
  // ══════════════════════════════════════════════════════════════
  function _renderAuthUI(user) {
    const section = document.getElementById('authSidebarSection');
    if (!section) return;

    if (user) {
      const photo    = user.photoURL || '';
      const name     = user.displayName || 'User';
      const email    = user.email || '';
      const initial  = name.charAt(0).toUpperCase();
      const avatar   = photo
        ? `<img class="auth-avatar" src="${_esc2(photo)}" alt="${initial}" referrerpolicy="no-referrer">`
        : `<div class="auth-avatar-placeholder">${initial}</div>`;
      section.innerHTML = `
        <div class="auth-section">
          <div class="auth-user-row">
            ${avatar}
            <div class="auth-user-info">
              <div class="auth-user-name">${_esc2(name)}</div>
              <div class="auth-user-email">${_esc2(email)}</div>
              <div class="auth-sync-badge"><div class="auth-sync-dot"></div>Cloud sync on</div>
            </div>
            <button class="auth-signout-btn" id="_auraSignOutBtn" title="Sign out">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
            </button>
          </div>
        </div>`;
      document.getElementById('_auraSignOutBtn').addEventListener('click', _googleSignOut);
    } else {
      section.innerHTML = `
        <div class="auth-section">
          <button class="auth-signin-btn" id="_auraSidebarSignIn">
            <svg width="14" height="14" viewBox="0 0 48 48">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.08 17.74 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-3.59-13.46-8.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            </svg>
            Sign in with Google
          </button>
        </div>`;
      // Opens the sign-in panel (Google + email) so the button works inside a WebView too
      document.getElementById('_auraSidebarSignIn').addEventListener('click', _showAuthPopup);
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  FEATURE GATING  — always active (locked when not signed in)
  // ══════════════════════════════════════════════════════════════
  function _applyFeatureGating(user) {
    const attach  = document.getElementById('attachBtn');
    const imgMode = document.getElementById('imgModeBtn');
    if (!attach || !imgMode) return;
    if (user) {
      attach.classList.remove('locked');  imgMode.classList.remove('locked');
      attach.title  = 'Attach images';
      imgMode.title = 'Image generation mode';
    } else {
      attach.classList.add('locked');  imgMode.classList.add('locked');
      attach.title  = '🔒 Sign in to upload images';
      imgMode.title = '🔒 Sign in to generate images';
    }
  }

  // Capture-phase click guards — intercept BEFORE original handlers
  document.getElementById('attachBtn').addEventListener('click', e => {
    if (_currentUser) return; // logged in — let original handler run
    e.stopImmediatePropagation();
    e.preventDefault();
    _showAuthPopup();
  }, true);

  document.getElementById('imgModeBtn').addEventListener('click', e => {
    if (_currentUser) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    _showAuthPopup();
  }, true);

  // Also block auto-detected image generation prompts for guests
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      if (!window.chatBot) return;
      const _origImgGen = window.chatBot._sendImageGen.bind(window.chatBot);
      window.chatBot._sendImageGen = function(text) {
        if (!_currentUser) { _showAuthPopup(); return; }
        return _origImgGen(text);
      };
    }, 400);
  });

  // ══════════════════════════════════════════════════════════════
  //  SIGN-IN POPUP  — always works
  // ══════════════════════════════════════════════════════════════
  const _authPopup = document.getElementById('signInPopupOverlay');

  function _showAuthPopup() {
    if (_currentUser) return;
    _emailMsg('');
    _authPopup.classList.add('visible');
    const hint = document.getElementById('popupTimerHint');
    if (hint) hint.textContent = 'This reminder appears every 15 minutes.';
  }

  function _hideAuthPopup() {
    _authPopup.classList.remove('visible');
  }

  document.getElementById('closeSignInPopup').addEventListener('click', _hideAuthPopup);
  document.getElementById('popupGuestBtn').addEventListener('click', _hideAuthPopup);
  document.getElementById('popupGoogleSignInBtn').addEventListener('click', _googleSignIn);
  _authPopup.addEventListener('click', e => { if (e.target === _authPopup) _hideAuthPopup(); });

  // Email / password wiring
  (function _wireEmailAuth() {
    const form = document.getElementById('emailAuthForm');
    if (form) form.addEventListener('submit', _emailAuthSubmit);
    const sw = document.getElementById('authSwitchMode');
    if (sw) sw.addEventListener('click', () => _setEmailMode(_emailMode === 'signup' ? 'signin' : 'signup'));
    const pw = document.getElementById('authPassword');
    if (pw) pw.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); _emailAuthSubmit(e); } });
  })();

  // ══════════════════════════════════════════════════════════════
  //  POPUP TIMER — on open + every 15 min
  // ══════════════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => { if (!_currentUser) _showAuthPopup(); }, 2800);
    setInterval(() => { if (!_currentUser) _showAuthPopup(); }, 15 * 60 * 1000);
    _renderAuthUI(null);
    _applyFeatureGating(null);
  });

  // ══════════════════════════════════════════════════════════════
  //  FIRESTORE SYNC — push index + each session
  // ══════════════════════════════════════════════════════════════

  // Push the chat index (list of session metadata) to Firestore
  async function _pushIndexToFirestore(sessions) {
    if (!_currentUser || !_fbDb) return;
    try {
      await _fbDb.collection('users').doc(_currentUser.uid)
        .set({ chatIndex: sessions, updatedAt: Date.now() }, { merge: true });
    } catch(e) { console.warn('[AURA FS index]', e.message); }
  }

  // Push a single session's messages to Firestore
  async function _pushSessionToFirestore(id, msgs) {
    if (!_currentUser || !_fbDb) return;
    try {
      const clean = msgs.map(m => { const {imgUrls,...r} = m; return r; });
      await _fbDb.collection('users').doc(_currentUser.uid)
        .collection('sessions').doc(id)
        .set({ messages: clean, updatedAt: Date.now() });
    } catch(e) { console.warn('[AURA FS session]', e.message); }
  }

  // Push ALL local sessions to Firestore (called after sign-in to upload guest chats)
  async function _pushAllLocalToFirestore(user) {
    if (!_fbDb || !user) return;
    try {
      const sessions = Store.listSessions();
      if (!sessions.length) return;
      // Push index
      await _fbDb.collection('users').doc(user.uid)
        .set({ chatIndex: sessions, updatedAt: Date.now() }, { merge: true });
      // Push each session's messages
      for (const s of sessions) {
        const msgs = Store.loadMessages(s.id);
        if (!msgs.length) continue;
        const clean = msgs.map(m => { const {imgUrls,...r} = m; return r; });
        await _fbDb.collection('users').doc(user.uid)
          .collection('sessions').doc(s.id)
          .set({ messages: clean, updatedAt: Date.now() }, { merge: true });
      }
    } catch(e) { console.warn('[AURA FS pushAll]', e.message); }
  }

  // Pull ALL sessions from Firestore and merge with local (cloud wins for same IDs)
  async function _pullFromFirestore(user) {
    if (!_fbDb || _syncInProgress) return;
    _syncInProgress = true;
    try {
      const doc = await _fbDb.collection('users').doc(user.uid).get();
      if (!doc.exists) { _syncInProgress = false; return; }

      const cloudIndex = doc.data().chatIndex || [];
      if (!cloudIndex.length) { _syncInProgress = false; return; }

      // Merge cloud index with any local sessions the user may have made as guest
      const localIndex  = Store.listSessions();
      const localIds    = new Set(localIndex.map(s => s.id));
      const cloudIds    = new Set(cloudIndex.map(s => s.id));

      // Build merged index: cloud entries + any local-only entries not yet in cloud
      const localOnly   = localIndex.filter(s => !cloudIds.has(s.id));
      const mergedIndex = [...cloudIndex, ...localOnly]
        .sort((a, b) => b.ts - a.ts)   // newest first
        .slice(0, 50);

      // Write merged index to localStorage
      localStorage.setItem(Store.KEY_INDEX, JSON.stringify(mergedIndex));

      // Pull every cloud session into localStorage
      const sessionDocs = await _fbDb.collection('users').doc(user.uid)
        .collection('sessions').get();

      sessionDocs.forEach(sd => {
        const msgs = sd.data().messages || [];
        localStorage.setItem(Store.KEY_SESSION(sd.id), JSON.stringify(msgs));
      });

      // Refresh the UI
      if (window.chatBot) {
        window.chatBot._renderSidebar();
        const list = Store.listSessions();
        if (list.length) window.chatBot._loadSession(list[0].id);
        window.chatBot.toast('✓ Chats synced from your account.', 'success', 3000);
      }
    } catch(e) {
      console.warn('[AURA FS pull]', e.message);
    } finally {
      _syncInProgress = false;
    }
  }

  // ── Mirror every Store write → Firestore in real-time ──────────
  const _origSaveMsgs = Store.saveMessages.bind(Store);
  Store.saveMessages = (id, msgs) => {
    _origSaveMsgs(id, msgs);
    _pushSessionToFirestore(id, msgs);   // always push session
  };

  const _origSaveIdx = Store.saveIndex.bind(Store);
  Store.saveIndex = list => {
    _origSaveIdx(list);
    _pushIndexToFirestore(list);         // always push index
  };
