
/* RED MUSIC AVATAR CROPPER
   Circular fixed mask + drag + zoom + touch pinch + canvas export.
   The saved result is a square PNG; the existing avatar-shape system
   still controls how it is displayed (circle/square/VIP shapes).
*/
(function(){
  const CROP_SIZE=512;
  const state={
    src:"",
    type:"",
    image:null,
    scale:1,
    minScale:1,
    x:0,
    y:0,
    baseW:0,
    baseH:0,
    stageW:0,
    stageH:0,
    dragging:false,
    pointerId:null,
    startX:0,
    startY:0,
    startPanX:0,
    startPanY:0,
    pointers:new Map(),
    pinchStartDistance:0,
    pinchStartScale:1
  };

  function $(id){return document.getElementById(id)}
  function stage(){return $("rm-avatar-crop-stage")}
  function image(){return $("rm-avatar-crop-image")}
  function zoom(){return $("rm-avatar-crop-zoom")}
  function modal(){return $("rm-avatar-cropper")}

  function clamp(v,a,b){return Math.max(a,Math.min(b,v))}

  function measure(){
    const s=stage();
    if(!s || !state.image || !state.image.naturalWidth)return;
    state.stageW=s.clientWidth;
    state.stageH=s.clientHeight;

    state.minScale=Math.max(
      state.stageW/state.image.naturalWidth,
      state.stageH/state.image.naturalHeight
    );

    const currentZoom=Number(zoom().value||1);
    state.scale=state.minScale*currentZoom;
    clampPan();
    render();
  }

  function clampPan(){
    const w=state.image.naturalWidth*state.scale;
    const h=state.image.naturalHeight*state.scale;
    const maxX=Math.max(0,(w-state.stageW)/2);
    const maxY=Math.max(0,(h-state.stageH)/2);
    state.x=clamp(state.x,-maxX,maxX);
    state.y=clamp(state.y,-maxY,maxY);
  }

  function render(){
    if(!state.image)return;
    const img=image();
    img.style.width=(state.image.naturalWidth*state.scale)+"px";
    img.style.height=(state.image.naturalHeight*state.scale)+"px";
    img.style.transform=
      "translate(-50%,-50%) translate("+state.x+"px,"+state.y+"px)";
    const z=Number(zoom().value||1);
    $("rm-avatar-crop-zoom-value").textContent=Math.round(z*100)+"%";
  }

  function setZoom(value,focusX,focusY){
    if(!state.image)return;
    const s=stage();
    const oldScale=state.scale;
    const nextZoom=clamp(Number(value)||1,1,3);
    const nextScale=state.minScale*nextZoom;

    // Keep the point under the cursor/finger stable while zooming.
    if(Number.isFinite(focusX) && Number.isFinite(focusY) && oldScale>0){
      const localX=focusX-state.stageW/2-state.x;
      const localY=focusY-state.stageH/2-state.y;
      state.x += localX*(1-nextScale/oldScale);
      state.y += localY*(1-nextScale/oldScale);
    }

    state.scale=nextScale;
    zoom().value=String(nextZoom);
    clampPan();
    render();
  }

  window.openAvatarCropper=function(dataUrl,mimeType){
    const m=modal();
    const img=image();
    if(!m||!img)return;

    state.src=dataUrl;
    state.type=mimeType||"";
    state.image=new Image();
    state.image.onload=function(){
      m.classList.add("rm-open");
      m.setAttribute("aria-hidden","false");
      document.body.style.overflow="hidden";
      requestAnimationFrame(function(){
        zoom().value="1";
        state.x=0;
        state.y=0;
        measure();
      });
    };
    state.image.onerror=function(){
      alert("Не удалось открыть изображение.");
      closeAvatarCropper();
    };
    state.image.src=dataUrl;
  };

  window.closeAvatarCropper=function(){
    const m=modal();
    if(!m)return;
    m.classList.remove("rm-open");
    m.setAttribute("aria-hidden","true");
    document.body.style.overflow="";
    state.src="";
    state.type="";
    state.image=null;
    state.pointers.clear();
  };

  window.saveAvatarCrop=function(){
    if(!state.image)return;
    const canvas=document.createElement("canvas");
    canvas.width=CROP_SIZE;
    canvas.height=CROP_SIZE;
    const ctx=canvas.getContext("2d");
    if(!ctx)return;

    // Export exactly the same square region seen by the crop mask.
    const scaleOut=CROP_SIZE/state.stageW;
    const drawW=state.image.naturalWidth*state.scale*scaleOut;
    const drawH=state.image.naturalHeight*state.scale*scaleOut;
    const dx=(CROP_SIZE-drawW)/2 + state.x*scaleOut;
    const dy=(CROP_SIZE-drawH)/2 + state.y*scaleOut;

    ctx.clearRect(0,0,CROP_SIZE,CROP_SIZE);
    ctx.drawImage(state.image,dx,dy,drawW,drawH);

    let result;
    try{
      result=canvas.toDataURL("image/png");
      // A 512x512 PNG is normally small, but avoid exceeding the app's 2 MB
      // avatar limit for unusually complex source images.
      if(result.length>2.6*1024*1024){
        result=canvas.toDataURL("image/jpeg",0.88);
      }
    }catch(e){
      alert("Не удалось сохранить обрезанную аватарку.");
      return;
    }

    if(result.length>2.8*1024*1024){
      alert("Получившаяся аватарка слишком большая. Попробуйте уменьшить детализацию изображения.");
      return;
    }

    const u=typeof currentUser==="function"?currentUser():null;
    if(!u)return;

    u.avatar=result;
    if(typeof saveUsers==="function"){
      saveUsers(loadUsers().map(x=>Number(x.id)===Number(u.id)?u:x));
    }
    if(typeof updateUserUI==="function")updateUserUI();
    if(typeof syncProfileToServer==="function")syncProfileToServer(u);
    if(typeof addLog==="function")addLog("Изменён и обрезан аватар");

    closeAvatarCropper();
  };

  function pointerDown(e){
    const s=stage();
    if(!s)return;
    s.setPointerCapture?.(e.pointerId);
    state.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(state.pointers.size===1){
      state.dragging=true;
      state.pointerId=e.pointerId;
      state.startX=e.clientX;
      state.startY=e.clientY;
      state.startPanX=state.x;
      state.startPanY=state.y;
      s.classList.add("rm-dragging");
    }else if(state.pointers.size===2){
      const pts=[...state.pointers.values()];
      state.pinchStartDistance=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);
      state.pinchStartScale=Number(zoom().value||1);
      state.dragging=false;
    }
    e.preventDefault();
  }

  function pointerMove(e){
    if(!state.pointers.has(e.pointerId))return;
    state.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});

    if(state.pointers.size===2){
      const pts=[...state.pointers.values()];
      const dist=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);
      if(state.pinchStartDistance>0){
        const factor=dist/state.pinchStartDistance;
        const midX=(pts[0].x+pts[1].x)/2;
        const midY=(pts[0].y+pts[1].y)/2;
        const rect=stage().getBoundingClientRect();
        const fx=midX-rect.left;
        const fy=midY-rect.top;
        setZoom(state.pinchStartScale*factor,fx-state.stageW/2,fy-state.stageH/2);
      }
      e.preventDefault();
      return;
    }

    if(state.dragging && state.pointerId===e.pointerId){
      state.x=state.startPanX+(e.clientX-state.startX);
      state.y=state.startPanY+(e.clientY-state.startY);
      clampPan();
      render();
      e.preventDefault();
    }
  }

  function pointerUp(e){
    state.pointers.delete(e.pointerId);
    if(state.pointers.size===0){
      state.dragging=false;
      state.pointerId=null;
      stage().classList.remove("rm-dragging");
    }else if(state.pointers.size===1){
      const p=[...state.pointers.entries()][0];
      state.pointerId=p[0];
      state.startX=p[1].x;
      state.startY=p[1].y;
      state.startPanX=state.x;
      state.startPanY=state.y;
      state.dragging=true;
      state.pinchStartDistance=0;
    }
  }

  function wheel(e){
    if(!modal().classList.contains("rm-open"))return;
    e.preventDefault();
    const rect=stage().getBoundingClientRect();
    const fx=e.clientX-rect.left-state.stageW/2;
    const fy=e.clientY-rect.top-state.stageH/2;
    const current=Number(zoom().value||1);
    const next=current*(e.deltaY<0?1.08:.92);
    setZoom(next,fx,fy);
  }

  function init(){
    const s=stage();
    if(!s)return;
    s.addEventListener("pointerdown",pointerDown);
    s.addEventListener("pointermove",pointerMove);
    s.addEventListener("pointerup",pointerUp);
    s.addEventListener("pointercancel",pointerUp);
    s.addEventListener("pointerleave",function(e){
      if(e.pointerType==="mouse" && state.pointers.has(e.pointerId))pointerUp(e);
    });
    s.addEventListener("wheel",wheel,{passive:false});
    zoom().addEventListener("input",function(){setZoom(this.value)});
    window.addEventListener("resize",function(){
      if(modal().classList.contains("rm-open"))measure();
    });

    document.addEventListener("keydown",function(e){
      if(e.key==="Escape" && modal().classList.contains("rm-open"))closeAvatarCropper();
    });

    modal().addEventListener("click",function(e){
      if(e.target===modal())closeAvatarCropper();
    });
  }

  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded",init,{once:true});
  }else{
    init();
  }
})();
