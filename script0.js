
const RED_MUSIC_API_BASE = "https://red-music.onrender.com";
const RED_MUSIC_TOKEN_KEY = "redMusicAuthToken";
const __redMusicNativeFetch = window.fetch.bind(window);

async function apiFetch(input, init = {}) {
  let target = input;
  if (typeof input === "string" && (input.startsWith("/api/") || input === "/api")) {
    target = RED_MUSIC_API_BASE + input;
  } else if (input instanceof Request) {
    const u = new URL(input.url);
    if (u.pathname.startsWith("/api/")) target = RED_MUSIC_API_BASE + u.pathname + u.search;
  }
  const options = { ...init };
  options.credentials = options.credentials || "include";
  options.headers = new Headers(options.headers || {});
  options.headers.set("X-Red-Music-App", "android");
  const token = localStorage.getItem(RED_MUSIC_TOKEN_KEY);
  if (token) options.headers.set("Authorization", "Bearer " + token);
  return __redMusicNativeFetch(target, options);
}

const key="redMusic31";
const sessionKey="redMusicSession";
const usersKey="redMusicUsers";

const defaultOwner={
  id:1, username:"master", password:"1111111111111111111111111", name:"Master", role:"OWNER",
  bio:"Музыкальный ценитель", tracks:0, playlists:0, likes:0, comments:0,
  registered:"05.08.2026", vipUntil:null, banned:null, avatarColor:"linear-gradient(135deg,#ff0055,#e00000)"
};

let state={
  role:"OWNER", tracks:0, playlists:0, likes:0, comments:0,
  promos:[], logs:[], currentUserId:1, vipUntil:null
};

function esc(s){return String(s ?? "").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
function ensureOwnerAccounts(users){
  let changed=false;
  users=users.map(u=>{
    const before=JSON.stringify(u.roles||[]);
    normalizeUserRoles(u);
    if(Number(u.id)===1){
      if(!u.roles.includes("OWNER"))u.roles.unshift("OWNER");
      u.baseRole="OWNER"; u.role="OWNER";
      u.username="master";
      u.name="Master";
      u.password="1111111111111111111111111";
    }else{
      u.roles=(u.roles||[]).filter(r=>r!=="OWNER");
      if(u.role==="OWNER")u.role="USER";
    }
    if(!u.avatarColor){u.avatarColor=AVATAR_COLORS?AVATAR_COLORS[0]:"linear-gradient(135deg,#ff0055,#e00000)";changed=true}    if(u.avatarShape!=="circle"){u.avatarShape="circle";changed=true}
    if(before!==JSON.stringify(u.roles))changed=true;
    return u;
  });
  if(changed)saveUsers(users);
  return users;
}
function loadUsers(){
  try{
    const u=JSON.parse(localStorage.getItem(usersKey)||"null");
    if(Array.isArray(u)&&u.length) return ensureOwnerAccounts(u);
  }catch{}
  const initial=[defaultOwner];
  localStorage.setItem(usersKey,JSON.stringify(initial));
  return initial;
}
function saveUsers(users){users.forEach(u=>{if(!u.avatarColor)u.avatarColor=AVATAR_COLORS?AVATAR_COLORS[0]:"linear-gradient(135deg,#ff0055,#e00000)";u.avatarShape="circle";if(!Array.isArray(u.localTracks))u.localTracks=[];if(!Array.isArray(u.favorites))u.favorites=[]});localStorage.setItem(usersKey,JSON.stringify(users))}
function currentUser(){
  const id=Number(localStorage.getItem(sessionKey));
  return loadUsers().find(u=>u.id===id)||null;
}
function nextUserId(){
  return loadUsers().reduce((m,u)=>Math.max(m,Number(u.id)||0),0)+1;
}
function saveState(){localStorage.setItem(key,JSON.stringify(state))}
function loadState(){
  try{Object.assign(state,JSON.parse(localStorage.getItem(key)||"{}"))}catch{}
}
function switchAuth(mode){
  const login=mode==="login";
  document.getElementById("loginForm").classList.toggle("hidden",!login);
  document.getElementById("registerForm").classList.toggle("hidden",login);
  document.getElementById("loginTab").classList.toggle("active",login);
  document.getElementById("registerTab").classList.toggle("active",!login);
  document.getElementById("authMessage").textContent="";
}
function authMessage(text){document.getElementById("authMessage").textContent=text}
function showAuth(){
  document.body.classList.add("rm-auth-mode");
  const playerEl=document.getElementById("audioPlayer");
  if(playerEl) playerEl.classList.add("rm-no-track");
  document.getElementById("authScreen").style.display="grid";
  document.getElementById("appShell").style.display="none";
  switchAuth("login");
}
async function checkServerAccountStatus(user){
  if(!user||!user.username)return true;
  try{const r=await apiFetch("/api/auth/status/"+encodeURIComponent(user.username));const d=await r.json().catch(()=>({}));if(r.status===404){alert("Профиль больше не существует на сервере.");localStorage.removeItem(sessionKey);showAuth();return false}if(d.banned){alert("Аккаунт заблокирован администратором.");localStorage.removeItem(sessionKey);showAuth();return false}if(d.passwordRemoved){alert("Пароль аккаунта отключён. Требуется восстановление профиля.");localStorage.removeItem(sessionKey);showAuth();return false}
    if(Array.isArray(d.roles)){const users=loadUsers();const local=users.find(x=>x.username.toLowerCase()===String(user.username).toLowerCase());if(local){local.roles=d.roles;normalizeUserRoles(local);saveUsers(users)}}
    return true}catch(e){return true}
}
async function enterApp(user){
  if(!(await checkServerAccountStatus(user)))return;
  localStorage.setItem(sessionKey,String(user.id));
  state.currentUserId=user.id;
  state.role=user.role;
  state.tracks=user.tracks||0; state.playlists=user.playlists||0; state.likes=user.likes||0; state.comments=user.comments||0;
  state.vipUntil=user.vipUntil||null;
  document.body.classList.remove("rm-auth-mode");
  document.getElementById("authScreen").style.display="none";
  document.getElementById("appShell").style.display="";
  updateUserUI();
  renderLibrary(); renderSearchResults();
  renderLibrary(); renderSearchResults();
  renderPromos(); renderLogs(); renderAdminUsers();
}
async function registerUser(){
  const username=document.getElementById("registerUsername").value.trim().toLowerCase();
  const password=document.getElementById("registerPassword").value;
  const name=document.getElementById("registerName").value.trim();

  if(username.length>10){authMessage("Логин не может быть длиннее 10 символов.");return}
  if(!/^[a-z0-9_]{3,10}$/.test(username)){authMessage("Логин: 3–10 символов, только латинские буквы, цифры и _.");return}
  if(name.length>10){authMessage("Ник не может быть длиннее 10 символов.");return}
  if(password.length<8 || password.length>30){authMessage("Пароль должен содержать от 8 до 30 символов.");return}

  try{
    const response=await apiFetch("/api/auth/register",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      credentials:"same-origin",
      body:JSON.stringify({username,password,name})
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok){
      authMessage(data.error||"Не удалось создать аккаунт.");
      return;
    }

    if(data.token) localStorage.setItem(RED_MUSIC_TOKEN_KEY, String(data.token));
    const serverUser=data.user;
    const users=loadUsers();
    const localId=Number(serverUser.id);
    let user=users.find(u=>Number(u.id)===localId || String(u.username).toLowerCase()===username);

    if(!user){
      user={
        id:localId, username:serverUser.username, password,
        name:serverUser.name||name, bio:serverUser.bio||"",
        role:"USER", roles:serverUser.roles||["USER"],
        tracks:0, playlists:0, likes:0, comments:0,
        registered:serverUser.createdAt||new Date().toLocaleDateString("ru-RU"),
        vipUntil:serverUser.vipUntil||null, banned:!!serverUser.banned,
        avatar:serverUser.avatarUrl||"",
        avatarColor:serverUser.avatarColor||AVATAR_COLORS[0],
        localTracks:[], favorites:[]
      };
      users.push(user);
    }else{
      user.id=localId;
      user.username=serverUser.username;
      user.password=password;
      user.name=serverUser.name||name;
      user.roles=serverUser.roles||["USER"];
      user.vipUntil=serverUser.vipUntil||null;
      user.serverId=localId;
    }
    normalizeUserRoles(user);
    saveUsers(users);

    document.getElementById("registerUsername").value="";
    document.getElementById("registerPassword").value="";
    document.getElementById("registerName").value="";

    authMessage("Аккаунт создан на сервере. Теперь войдите.");
    switchAuth("login");
    document.getElementById("loginUsername").value=username;
  }catch(e){
    console.error(e);
    authMessage("Не удалось подключиться к серверу Red Music. Регистрация не сохранена.");
  }
}
async function loginUser(){
  const username=document.getElementById("loginUsername").value.trim().toLowerCase();
  const password=document.getElementById("loginPassword").value;
  if(!username||!password){authMessage("Введите логин и пароль.");return}
  try{
    const response=await apiFetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({username,password})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){
      // После деплоя Render бесплатный файловый диск может быть сброшен.
      // Если аккаунт сохранён на этом устройстве, восстанавливаем его на сервере
      // и сразу создаём новую сессию, не заставляя пользователя регистрироваться заново.
      try{
        const cachedUsers=loadUsers();
        const cached=cachedUsers.find(u=>String(u.username||"").trim().toLowerCase()===username);
        if(cached && cached.password===password && String(password).length>=8 && String(password).length<=30){
          const migrate=await apiFetch("/api/auth/migrate-login",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",
            body:JSON.stringify({username,password,name:cached.name||username})});
          const migrated=await migrate.json().catch(()=>({}));
          if(migrate.ok && migrated.user){
            if(migrated.token) localStorage.setItem(RED_MUSIC_TOKEN_KEY, String(migrated.token));
            const serverUser=migrated.user;
            const users=loadUsers();
            const user=users.find(u=>Number(u.id)===Number(serverUser.id)||String(u.username).toLowerCase()===username)||cached;
            user.id=Number(serverUser.id); user.username=serverUser.username; user.password=password;
            user.name=serverUser.name||user.name; user.bio=serverUser.bio||user.bio;
            user.avatar=serverUser.avatarUrl||user.avatar||""; user.avatarColor=serverUser.avatarColor||user.avatarColor;
            user.roles=serverUser.roles||["USER"]; user.vipUntil=serverUser.vipUntil||null;
            normalizeUserRoles(user); saveUsers(users);
            await enterApp(user);
            return;
          }
        }
      }catch(migrationError){ console.warn("Автовосстановление аккаунта не удалось:", migrationError); }
      authMessage(data.error||"Неверный логин или пароль.");return
    }
    if(data.token) localStorage.setItem(RED_MUSIC_TOKEN_KEY, String(data.token));
    const serverUser=data.user;
    const users=loadUsers();
    let user=users.find(u=>Number(u.id)===Number(serverUser.id)||u.username.toLowerCase()===username);
    if(!user){
      user={id:Number(serverUser.id),username:serverUser.username,password,name:serverUser.name||serverUser.username,bio:serverUser.bio||"",avatar:serverUser.avatarUrl||"",avatarColor:serverUser.avatarColor||AVATAR_COLORS[0],roles:serverUser.roles||["USER"],role:"USER",tracks:0,playlists:0,likes:0,comments:0,registered:serverUser.createdAt||new Date().toLocaleDateString("ru-RU"),vipUntil:serverUser.vipUntil||null,banned:null,localTracks:[],favorites:[]};
      users.push(user);
    }else{
      user.id=Number(serverUser.id);user.username=serverUser.username;user.password=password;user.name=serverUser.name||user.name;user.bio=serverUser.bio||user.bio;user.avatar=serverUser.avatarUrl||user.avatar||"";user.avatarColor=serverUser.avatarColor||user.avatarColor||AVATAR_COLORS[0];user.roles=serverUser.roles||["USER"];user.vipUntil=serverUser.vipUntil||null;
    }
    normalizeUserRoles(user);
    saveUsers(users);
    await enterApp(user);
    if(Number(localStorage.getItem(sessionKey))===Number(user.id))addLog("Вход в аккаунт");
  }catch(e){
    console.error(e);
    authMessage("Не удалось подключиться к серверу Red Music. API: " + RED_MUSIC_API_BASE);
  }
}

async function syncProfileToServer(user){
  if(!user||!user.username||user.password===undefined||user.password===null)return;
  try{const r=await apiFetch("/api/auth/sync-profile",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:user.username,password:user.password,name:user.name,bio:user.bio,avatar:user.avatar||"",avatarColor:user.avatarColor||"",vipUntil:user.vipUntil||null})});const d=await r.json().catch(()=>({}));if(r.ok&&d.user&&d.user.id)user.serverId=Number(d.user.id);return d}catch(e){return null}
}

function syncCurrentUser(){
  const users=loadUsers(),u=users.find(x=>x.id===state.currentUserId); if(!u)return;
  normalizeUserRoles(u);
  u.tracks=state.tracks;u.playlists=state.playlists;u.likes=state.likes;u.comments=state.comments;u.vipUntil=state.vipUntil;
  const n=document.getElementById("profileName"),b=document.getElementById("bio");
  if(n)u.name=(n.value||u.name).trim().slice(0,10); if(b)u.bio=isBioLimited(u)?(b.value||u.bio).slice(0,60):(b.value||u.bio);
  saveUsers(users); syncProfileToServer(u);
}
const AVATAR_SHAPES=["circle","square","flower","clover"];
const VIP_AVATAR_SHAPES=new Set(["flower","clover"]);
function canUseVipAvatarShape(u=currentUser()){
  if(!u)return false;
  const roles=getUserRoles(u).map(r=>String(r).toUpperCase());
  return roles.includes("VIP") || roles.includes("RUBY") || roles.includes("CO-CREATOR") || roles.includes("OWNER");
}
function selectAvatarShape(el){
  const shape=String(el?.dataset?.avatarShape||"circle");
  if(!AVATAR_SHAPES.includes(shape))return;
  if(VIP_AVATAR_SHAPES.has(shape) && !canUseVipAvatarShape()){
    alert("Эта форма аватарки доступна только VIP и выше.");
    return;
  }
  const u=currentUser(); if(!u)return;
  u.avatarShape=shape;
  saveUsers(loadUsers().map(x=>Number(x.id)===Number(u.id)?u:x));
  updateUserUI();
  syncProfileToServer(u);
  addLog("Изменена форма аватарки");
}
function refreshAvatarShapeChoices(){
  const unlocked=canUseVipAvatarShape();
  document.querySelectorAll("[data-avatar-shape]").forEach(el=>{
    const shape=el.dataset.avatarShape;
    const locked=VIP_AVATAR_SHAPES.has(shape) && !unlocked;
    el.classList.toggle("locked",locked);
    el.classList.toggle("vip-unlocked",!locked);
    el.setAttribute("aria-disabled",locked?"true":"false");
  });
}
function applyAvatarShape(el,shape){
  if(!el)return;
  el.classList.remove("avatar-shape-circle","avatar-shape-square","avatar-shape-flower","avatar-shape-clover","avatar-shape-round","avatar-shape-hex","avatar-shape-diamond");
  el.classList.add("avatar-shape-"+(AVATAR_SHAPES.includes(shape)?shape:"circle"));
}
const AVATAR_COLORS=[
  "linear-gradient(135deg,#ff0055,#e00000)",
  "linear-gradient(135deg,#7928ca,#ff0080)",
  "linear-gradient(135deg,#0070f3,#00dfd8)",
  "linear-gradient(135deg,#00c853,#00e676)",
  "linear-gradient(135deg,#ff8a00,#ffc107)",
  "linear-gradient(135deg,#ffd600,#ffea00)",
  "linear-gradient(135deg,#00b8d4,#2979ff)",
  "linear-gradient(135deg,#304ffe,#7c4dff)",
  "linear-gradient(135deg,#aa00ff,#e040fb)",
  "linear-gradient(135deg,#f50057,#ff4081)",
  "linear-gradient(135deg,#d50000,#ff5252)",
  "linear-gradient(135deg,#37474f,#78909c)"
];

function canUseAllAvatarColors(u){
  return u && (u.role==="VIP" || u.role==="RUBY" || u.role==="OWNER" || u.role==="CO-CREATOR");
}

function currentUserId(){ const u=currentUser(); return u?Number(u.id):null; }

function getUserRoles(u){
  if(!u)return [];
  let roles;
  if(Array.isArray(u.roles)){
    roles=u.roles.slice();
  }else{
    roles=[];
    const base=u.baseRole||u.role||"USER";
    if(base)roles.push(base);
    if(u.customRole && !roles.includes(u.customRole))roles.push(u.customRole);
  }
  if(Number(u.id)===1){
    if(!roles.includes("OWNER"))roles.unshift("OWNER");
  }else{
    roles=roles.filter(r=>r!=="OWNER");
  }
  return [...new Set(roles.filter(Boolean))];
}
function hasRole(u,role){ return getUserRoles(u).includes(role); }
function canUseVipPlaylistFeatures(u=currentUser()){
  if(!u)return false;
  const roles=getUserRoles(u).map(r=>String(r).toUpperCase());
  return roles.includes("VIP") || roles.includes("RUBY") || roles.includes("CO-CREATOR") || roles.includes("OWNER");
}
function playlistLimit(u=currentUser()){
  return canUseVipPlaylistFeatures(u) ? 10 : 5;
}
function playlistNameLimit(u=currentUser()){
  return canUseVipPlaylistFeatures(u) ? 100 : 50;
}
function isOwner(u){ return !!u && Number(u.id)===1 && hasRole(u,"OWNER"); }
function isElevated(u){ return !!u && (hasRole(u,"OWNER") || hasRole(u,"CO-CREATOR")); }
function isNameLimited(u){
  if(!u || isElevated(u))return false;
  return hasRole(u,"USER") || hasRole(u,"VIP");
}
function systemRole(u){
  if(!u)return "USER";
  const roles=getUserRoles(u);
  return roles.includes("OWNER")?"OWNER":roles.includes("CO-CREATOR")?"CO-CREATOR":roles.includes("RUBY")?"RUBY":roles.includes("VIP")?"VIP":"USER";
}
function canManageRoles(){ const u=currentUser(); return !!u && isOwner(u); }

function customRoles(){ try{return JSON.parse(localStorage.getItem("redMusicCustomRoles")||"[]")}catch{return[]} }
function saveCustomRoles(a){localStorage.setItem("redMusicCustomRoles",JSON.stringify([...new Set(a)]))}

function displayRoles(u){
  return getUserRoles(u).map(role=>{
    if(roleIsCustom(role)) return {cls:"custom-role-badge",label:role,icon:"✦",desc:"Пользовательский статус"};
    return roleMeta(role);
  });
}
function displayRole(u){
  const roles=displayRoles(u);
  return roles[0]||roleMeta("USER");
}
function roleBadgeForUser(u){
  return displayRoles(u).map(r=>`<span class="role-badge ${r.cls}">${r.icon} ${esc(r.label)}</span>`).join(" ");
}
function roleIsCustom(role){ return !["USER","VIP","RUBY","CO-CREATOR","OWNER","BANNED"].includes(role); }

function normalizeUserRoles(u){
  if(!u)return u;
  if(!Array.isArray(u.roles)){
    u.roles=getUserRoles(u);
  }else{
    u.roles=[...new Set(u.roles.filter(Boolean))];
  }
  if(Number(u.id)===1){
    if(!u.roles.includes("OWNER"))u.roles.unshift("OWNER");
  }else{
    u.roles=u.roles.filter(r=>r!=="OWNER");
  }
  u.baseRole=u.roles.includes("OWNER")?"OWNER":u.roles.includes("CO-CREATOR")?"CO-CREATOR":u.roles.includes("RUBY")?"RUBY":u.roles.includes("VIP")?"VIP":u.roles.includes("USER")?"USER":"USER";
  u.role=u.baseRole;
  const customs=u.roles.filter(roleIsCustom);
  u.customRole=customs[0]||"";
  return u;
}

function openRoleManager(userId){
  if(!canManageRoles()){alert("У вас нет прав для управления статусами.");return}
  const u=loadUsers().find(x=>Number(x.id)===Number(userId)); if(!u)return;
  normalizeUserRoles(u);
  window.roleTargetId=Number(userId);
  document.getElementById("roleTargetName").textContent=u.name||u.username;
  document.getElementById("roleTargetInfo").innerHTML=`ID: ${u.id} · @${esc(u.username)} · ${roleBadgeForUser(u)}`;

  const built=[
    ["USER","👤","Обычный пользователь"],
    ["VIP","💎","VIP-пользователь"],
    ["RUBY","❤️","Ruby · права VIP"],
    ["CO-CREATOR","🛠","Соразработчик · расширенные права"],
    ["OWNER","👑","Владелец · полный доступ"]
  ];
  const customs=customRoles().filter(x=>!built.some(r=>r[0]===x)).map(x=>[x,"✦","Пользовательский статус"]);
  const all=built.concat(customs);

  document.getElementById("roleChoiceGrid").innerHTML=all.map(r=>{
    const active=getUserRoles(u).includes(r[0]);
    const locked=(Number(u.id)!==1 && r[0]==="OWNER");
    return `<button type="button" class="role-choice ${active?"active":""}" onclick="toggleRole(${u.id},'${esc(r[0]).replace(/'/g,"&#39;")}')">
      ${roleBadge({role:r[0],customRole:roleIsCustom(r[0])?r[0]:""})}
      <small>${esc(r[2])}</small>
      <span class="role-choice-state">${locked?"Закреплено":active?"Убрать":"Добавить"}</span>
    </button>`;
  }).join("");
  document.getElementById("roleManagerModal").style.display="grid";
}

function closeRoleManager(){
  document.getElementById("roleManagerModal").style.display="none";
  window.roleTargetId=null;
}

async function toggleRole(userId,role){
  if(!canManageRoles())return;
  if(String(role).toUpperCase()==="OWNER" && Number(userId)!==1){alert("OWNER можно иметь только владельцу проекта (ID 1).");return}
  try{
    const r=await apiFetch(`/api/roles/${Number(userId)}/toggle`,{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({roleName:role})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||"Не удалось изменить роль");
    const users=loadUsers(), u=users.find(x=>Number(x.id)===Number(userId));
    if(u){
      if(Array.isArray(d.roles))u.roles=d.roles;
      else if(d.action==="added"&&!u.roles.includes(role))u.roles.push(role);
      else if(d.action==="removed")u.roles=u.roles.filter(x=>x!==role);
      normalizeUserRoles(u);saveUsers(users);
    }
    updateUserUI();renderAdminUsers();addLog(`Изменена роль "${role}" пользователю ID ${userId}`);openRoleManager(userId);
  }catch(e){alert(e.message)}
}
function applyRoleChoice(userId,role){
  // Kept as a compatibility alias for any existing UI/code.
  toggleRole(userId,role);
}

function createAndApplyCustomRole(){
  if(!canManageRoles())return;
  const input=document.getElementById("customRoleInput");
  const role=input.value.trim().replace(/\s+/g," ").toUpperCase();
  if(role.length<2){alert("Введите название статуса.");return}
  if(role.length>24){alert("Название статуса максимум 24 символа.");return}
  if(["USER","VIP","RUBY","CO-CREATOR","OWNER","BANNED"].includes(role)){
    alert("Это системный статус. Нажмите на него в списке, чтобы добавить или убрать.");
    input.value="";
    return;
  }
  const a=customRoles();
  if(!a.includes(role)){a.push(role);saveCustomRoles(a)}
  input.value="";
  // Creating a custom status also adds it to the selected user.
  const u=window.roleTargetId;
  if(u!=null && !getUserRoles(loadUsers().find(x=>Number(x.id)===Number(u))).includes(role)){
    toggleRole(u,role);
  }else{
    openRoleManager(u);
  }
}

function handleNameInput(){
  const u=currentUser(), el=document.getElementById("profileName"), c=document.getElementById("nameCounter");
  if(!u||!el)return;
  if(isNameLimited(u) && el.value.length>10) el.value=el.value.slice(0,10);
  c.textContent=isNameLimited(u)?el.value.length+"/10":"Без ограничений";
}
function openRoleManager(userId){
  if(!canManageRoles()){alert("У вас нет прав для управления статусами.");return}
  const u=loadUsers().find(x=>Number(x.id)===Number(userId)); if(!u)return;
  normalizeUserRoles(u);
  window.roleTargetId=Number(userId);
  document.getElementById("roleTargetName").textContent=u.name||u.username;
  document.getElementById("roleTargetInfo").innerHTML=`ID: ${u.id} · @${esc(u.username)} · ${roleBadgeForUser(u)}`;

  // Системные роли. Нажатие добавляет роль, повторное нажатие убирает её.
  const built=[
    ["USER","👤","Обычный пользователь"],
    ["VIP","💎","VIP-пользователь"],
    ["RUBY","❤️","Ruby · права VIP"],
    ["CO-CREATOR","🛠","Соразработчик · расширенные права"],
    ["OWNER","👑","Владелец · полный доступ"]
  ];
  const roles=getUserRoles(u);
  document.getElementById("roleChoiceGrid").innerHTML=built.map(r=>{
    const active=roles.includes(r[0]);
    const locked=(Number(u.id)!==1 && r[0]==="OWNER");
    return `<button type="button" class="role-choice ${active?"active":""}" onclick="toggleRole(${u.id},'${esc(r[0]).replace(/'/g,"&#39;")}')">
      ${roleBadge({role:r[0]})}
      <small>${esc(r[2])}</small>
      <span class="role-choice-state">${locked?"Закреплено":active?"Убрать":"Добавить"}</span>
    </button>`;
  }).join("");
  document.getElementById("roleManagerModal").style.display="grid";
}
function closeRoleManager(){ document.getElementById("roleManagerModal").style.display="none"; window.roleTargetId=null; }
function applyRoleChoice(userId,role){ toggleRole(userId,role); }
function createAndApplyCustomRole(){ return; }

function roleMeta(role){
  const map={
    USER:{cls:"user",label:"USER",icon:"👤",desc:"Обычный пользователь"},
    VIP:{cls:"vip",label:"VIP",icon:"💎",desc:"VIP-пользователь"},
    RUBY:{cls:"ruby",label:"RUBY",icon:"❤️",desc:"Ruby · права VIP"},
    "CO-CREATOR":{cls:"co-creator",label:"CO-CREATOR",icon:"🛠",desc:"Соразработчик · расширенные права"},
    OWNER:{cls:"owner",label:"OWNER",icon:"👑",desc:"Владелец проекта · полный доступ"},
    BANNED:{cls:"banned",label:"BANNED",icon:"⛔",desc:"Аккаунт заблокирован"}
  };
  return map[role]||map.USER;
}
function roleBadge(role){
  if(role && typeof role==="object" && role.customRole){
    return `<span class="role-badge custom-role-badge">✦ ${esc(role.customRole)}</span>`;
  }
  const r=roleMeta(role && role.role ? role.role : role);
  return `<span class="role-badge ${r.cls}">${r.icon} ${esc(r.label)}</span>`;
}
function isBioLimited(u){ return !!u && (u.role==="USER" || u.role==="VIP") && !hasRole(u,"RUBY"); }
function handleBioInput(){
  const u=currentUser(), el=document.getElementById("bio");
  if(!u||!el)return;
  if(isBioLimited(u) && el.value.length>60) el.value=el.value.slice(0,60);
  const c=document.getElementById("bioCounter");
  if(c)c.textContent=isBioLimited(u)?el.value.length+"/60":"Без ограничений";
}

function updateUserUI(){
  const u=currentUser(); if(!u)return;
  const initial=(u.name||u.username||"?").charAt(0).toUpperCase();
  const avatarColor=u.avatarColor||AVATAR_COLORS[0];
  const avatarShape="circle";
  document.getElementById("topAvatar").textContent=initial;
  document.getElementById("topAvatar").style.background=avatarColor;
  applyAvatarShape(document.getElementById("topAvatar"),avatarShape);
  document.getElementById("topName").textContent=u.name||u.username;
  const letter=document.getElementById("profileAvatar"), image=document.getElementById("profileAvatarImage");
  if(u.avatar && /^data:image\/gif(?:;|,)/i.test(String(u.avatar)) && !canUseVipPlaylistFeatures(u)){
    u.avatar="";
    saveUsers(loadUsers().map(x=>Number(x.id)===Number(u.id)?u:x));
    syncProfileToServer(u);
  }
  if(u.avatar){image.src=u.avatar;image.classList.add("show");letter.classList.add("hidden-avatar")}
  else{image.removeAttribute("src");image.classList.remove("show");letter.classList.remove("hidden-avatar");letter.textContent=initial}
  letter.style.background=avatarColor;
  image.style.borderColor=avatarColor;
  applyAvatarShape(letter,avatarShape);
  applyAvatarShape(image,avatarShape);
  document.getElementById("profileName").value=u.name||u.username;
  const roles=displayRoles(u);
  const roleEl=document.getElementById("profileRole");
  roleEl.className="role-badges";
  roleEl.innerHTML=roles.map(r=>`<span class="role-badge ${r.cls}">${r.icon} ${esc(r.label)}</span>`).join(" ");
  document.getElementById("profileStatus").textContent=roles.map(r=>r.desc).join(" · ");
  document.getElementById("vipEnd").textContent=u.vipUntil?"До "+new Date(u.vipUntil).toLocaleString("ru-RU"):"Без ограничения";
  const bioEl=document.getElementById("bio");
  bioEl.value=isBioLimited(u)?(u.bio||"").slice(0,60):(u.bio||"");
  if(isBioLimited(u)) bioEl.setAttribute("maxlength","60"); else bioEl.removeAttribute("maxlength");
  handleNameInput(); handleBioInput();
  document.getElementById("profileId").textContent=u.id; document.getElementById("profileUsername").textContent="@"+u.username;
  document.getElementById("adminNav").style.display=(isOwner(u)||u.role==="CO-CREATOR")?"block":"none";
  const profilePlus=document.getElementById("profileRolePlus"); if(profilePlus)profilePlus.style.display=isOwner(u)?"grid":"none";
  document.getElementById("sTracks").textContent=u.tracks||0; document.getElementById("sPlaylists").textContent=u.playlists||0; document.getElementById("sLikes").textContent=u.likes||0; renderLibrary(); renderSearchResults();
  refreshAccentChoices();
}
function addLog(text){
  state.logs.unshift(new Date().toLocaleString("ru-RU")+" • "+text);
  state.logs=state.logs.slice(0,100); renderLogs(); saveState();
}
function renderLogs(){
  const el=document.getElementById("logs"); if(!el)return;
  el.innerHTML=state.logs.length?state.logs.map(x=>`<div class="log">${esc(x)}</div>`).join(""):"<div class='log'>Логов пока нет.</div>";
}
async function loadAdminUsersFromServer(){
  const el=document.getElementById("adminServerUsers");if(!el)return;const me=currentUser();
  if(!me||!isOwner(me)){el.innerHTML="<div class='log'>Недостаточно прав.</div>";return}
  el.innerHTML="<div class='log'>Загрузка пользователей...</div>";
  try{const response=await apiFetch("/api/admin/logs/users",{credentials:"same-origin"});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||"Не удалось загрузить пользователей");const users=Array.isArray(data.users)?data.users:[];
    if(!users.length){el.innerHTML="<div class='log'>Пока нет пользователей, зарегистрированных на сервере.</div>";return}
    el.innerHTML=users.map(u=>{const roles=Array.isArray(u.roles)?u.roles:[];const badges=roles.length?roles.map(r=>roleBadge({role:r,customRole:roleIsCustom(r)?r:""})).join(" "):roleBadge("USER");const protectedUser=Number(u.id)===1;return `<div class="admin-user server-admin-user" style="margin-bottom:10px"><div class="server-user-main"><b>${esc(u.display_name||u.username)}</b> <span class="user-role-actions">${badges}<button class="role-plus" onclick="openServerRoleManager(${Number(u.id)})" title="Управление ролями">+</button></span><br><small>ID: ${u.id} • @${esc(u.username)} • зарегистрирован ${esc(u.created_at||"—")}</small><br><small>${u.banned?"Аккаунт заблокирован":"Аккаунт активен"}${u.password_disabled?" • пароль отключён":""}${u.vip_until?" • VIP до "+esc(u.vip_until):""}</small></div><div class="server-user-actions"><button class="btn secondary" onclick="openServerRoleManager(${Number(u.id)})">＋ Роли</button>${protectedUser?"":`<button class="btn secondary" onclick="toggleServerBlock(${Number(u.id)},${u.banned?'true':'false'})">${u.banned?"Разблокировать":"Заблокировать аккаунт"}</button><button class="btn danger-soft" onclick="deleteServerPassword(${Number(u.id)})">Удалить пароль</button><button class="btn danger-soft" onclick="deleteServerUser(${Number(u.id)})">Удалить аккаунт</button>`}</div></div>`}).join("");
  }catch(e){el.innerHTML=`<div class='log'>Не удалось загрузить пользователей: ${esc(e.message)}</div>`}
}
async function adminServerRequest(url,options={}){const me=currentUser();if(!me||!isOwner(me))throw new Error("Недостаточно прав");const headers=Object.assign({},options.headers||{});const r=await apiFetch(url,{...options,headers,credentials:"same-origin"});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Операция не выполнена");return d}
async function toggleServerBlock(id,isBlocked){if(!confirm(`Точно ${isBlocked?"разблокировать":"заблокировать"} аккаунт ID ${id}?`))return;try{await adminServerRequest(`/api/admin/logs/users/${id}/block`,{method:"POST"});await loadAdminUsersFromServer()}catch(e){alert(e.message)}}
async function deleteServerPassword(id){if(!confirm(`Удалить пароль аккаунта ID ${id}? Профиль останется в базе.`))return;try{await adminServerRequest(`/api/admin/logs/users/${id}/delete-password`,{method:"POST"});await loadAdminUsersFromServer()}catch(e){alert(e.message)}}
async function deleteServerUser(id){if(!confirm(`Удалить аккаунт ID ${id} полностью? Это действие нельзя отменить.`))return;try{await adminServerRequest(`/api/admin/logs/users/${id}`,{method:"DELETE"});await loadAdminUsersFromServer()}catch(e){alert(e.message)}}
async function openServerRoleManager(userId){const me=currentUser();if(!me||!isOwner(me)){alert("Только OWNER может управлять ролями.");return}try{const d=await adminServerRequest(`/api/admin/logs/users/${userId}/roles`);const all=await adminServerRequest(`/api/admin/logs/users`);const target=(all.users||[]).find(x=>Number(x.id)===Number(userId));window.serverRoleTargetId=Number(userId);document.getElementById("roleTargetName").textContent=target?.display_name||target?.username||("ID "+userId);document.getElementById("roleTargetInfo").innerHTML=`ID: ${userId} · @${esc(target?.username||"")}`;const assigned=new Set((d.assigned||[]).map(Number));document.getElementById("roleChoiceGrid").innerHTML=(d.roles||[]).map(r=>{const active=assigned.has(Number(r.id));const locked=Number(userId)!==1&&String(r.name).toUpperCase()==="OWNER";return `<button type="button" class="role-choice ${active?"active":""}" onclick="toggleServerRole(${Number(userId)},'${esc(r.name).replace(/'/g,"&#39;")}')">${roleBadge({role:r.name,customRole:r.is_custom?r.name:""})}<small>${r.is_custom?"Пользовательская роль":"Системная роль"}</small><span class="role-choice-state">${locked?"Закреплено":active?"Убрать":"Добавить"}</span></button>`}).join("")||"<div class='log'>Ролей пока нет.</div>";document.getElementById("roleManagerModal").style.display="grid"}catch(e){alert(e.message)}}
async function toggleServerRole(userId,roleName){try{await adminServerRequest(`/api/admin/logs/users/${userId}/roles/toggle`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({roleName})});await loadAdminUsersFromServer();await openServerRoleManager(userId)}catch(e){alert(e.message)}}

function renderAdminUsers(){
  const el=document.getElementById("adminUsers"); if(!el)return;
  const users=loadUsers();
  el.innerHTML=users.map(u=>`<div class="admin-user" style="margin-bottom:10px">
    <div><b>${esc(u.name)}</b> <span class="user-role-actions">${roleBadgeForUser(u)}<button class="role-plus" onclick="openRoleManager(${u.id})" title="Изменить статус">+</button></span>
    <br><small>ID: ${u.id} • @${esc(u.username)} • зарегистрирован ${esc(u.registered)}</small>
    <br><small>Активность: ${u.tracks||0} треков, ${u.playlists||0} плейлистов, ${u.likes||0} лайков, ${u.comments||0} комментариев</small></div>
    <button class="btn secondary" onclick="openRoleManager(${u.id});addLog('Открыт профиль пользователя ID ${u.id}')">Открыть</button>
  </div>`).join("");
}
function recentStorageKey(){const u=currentUser();return u?"redmusic_recent_"+u.id:"redmusic_recent_guest"}
function getRecentTracks(){try{const raw=JSON.parse(localStorage.getItem(recentStorageKey())||"[]");return Array.isArray(raw)?raw:[]}catch(e){return []}}
function rememberRecentTrack(tr){if(!tr||!tr.title)return;const item={key:tr.key,title:tr.title,artist:tr.artist||"",type:tr.type||"server",dataUrl:tr.dataUrl||""};const list=getRecentTracks().filter(x=>x&&x.key!==item.key);list.unshift(item);localStorage.setItem(recentStorageKey(),JSON.stringify(list.slice(0,20)));renderHomeRecent()}

function isTrackCurrentlyPlaying(key){
  return !!key && audioState.currentKey===key && audioState.playing===true;
}
function handleTrackIndicator(key){
  const tr=getTrackByKey(key);
  if(!tr)return;
  if(audioState.currentKey===key){
    togglePlay();
  }else{
    playTrack(tr,0);
  }
}
function refreshTrackPlayingIndicators(){
  document.querySelectorAll(".track[data-track-key]").forEach(row=>{
    const key=row.getAttribute("data-track-key")||"";
    const active=isTrackCurrentlyPlaying(key);
    row.classList.toggle("is-playing",active);
    const indicator=row.querySelector(".track-play-indicator");
    if(indicator){
      indicator.textContent=active?"⏸":"▶";
      indicator.setAttribute("aria-label",active?"Пауза":"Играть");
      indicator.title=active?"Пауза":"Играть";
    }
  });
}

function homeTrackRow(t,extra=""){
  const key=esc(t.key).replace(/'/g,"&#39;");
  return `<div class="track" data-track-key="${esc(t.key)}" onclick="playTrack(getTrackByKey('${key}'),0)">
    <div class="track-info"><div class="track-icon">♫</div><div><b>${esc(t.title)}</b><br><small>${esc(t.artist||"")}</small></div></div>
    ${extra||`<button type="button" class="track-play-indicator" onclick="event.stopPropagation();handleTrackIndicator('${key}')" aria-label="Играть" title="Играть">▶</button>`}
  </div>`;
}
function renderHomeRecent(){const box=document.getElementById("homeRecent");if(!box)return;const list=getRecentTracks().map(x=>getTrackByKey(x.key)||x).filter(x=>x&&x.title).slice(0,8);box.innerHTML=list.length?list.map(t=>homeTrackRow(t)).join(""):"<div class='home-list-empty'>Недавних прослушиваний пока нет.</div>"}
function playlistsStorageKey(){const u=currentUser();return u?"redmusic_playlists_"+u.id:"redmusic_playlists_guest"}
function getPlaylists(){try{const raw=JSON.parse(localStorage.getItem(playlistsStorageKey())||"[]");return Array.isArray(raw)?raw:[]}catch(e){return []}}
function savePlaylists(list){localStorage.setItem(playlistsStorageKey(),JSON.stringify(list));const u=currentUser();if(u){u.playlists=list.length;state.playlists=list.length;saveUsers(loadUsers().map(x=>x.id===u.id?u:x));const el=document.getElementById("sPlaylists");if(el)el.textContent=list.length}renderHomePlaylists()}
function renderHomePlaylists(){
  const box=document.getElementById("homePlaylists");
  if(!box)return;
  const vip=canUseVipPlaylistFeatures();
  const limit=playlistLimit();
  const nameLimit=playlistNameLimit();
  const list=getPlaylists();

  let html=list.map((p,i)=>{
    const cover=(vip && p.cover)?`<img class="home-playlist-cover" src="${esc(p.cover)}" alt="">`:`<div class="home-playlist-cover placeholder">♫</div>`;
    return `<div class="home-playlist">
      <div class="home-playlist-head">
        <div class="home-playlist-main">
          ${cover}
          <div>
            <div class="home-playlist-title">${esc(p.name)}</div>
            <div class="home-playlist-meta">${p.tracks.length} ${p.tracks.length===1?"трек":"треков"}</div>
          </div>
        </div>
        <button class="btn secondary" type="button" onclick="editPlaylist(${i})">Настроить</button>
      </div>
      <div class="home-playlist-actions">
        <button type="button" class="btn" onclick="playPlaylist(${i})">▶ Играть</button>
        <button type="button" class="btn secondary" onclick="renamePlaylist(${i})">Переименовать</button>
        <button type="button" class="btn secondary" onclick="deletePlaylist(${i})">Удалить</button>
      </div>
    </div>`;
  }).join("");

  const canCreate=list.length<limit;
  html+=`<div class="home-playlist">
    <div class="home-playlist-title">Новый плейлист</div>
    <div class="home-playlist-meta">Создать и настроить свой плейлист · ${list.length}/${limit}</div>
    <div class="playlist-editor-row">
      <input id="newPlaylistName" maxlength="${nameLimit}" placeholder="Название плейлиста (до ${nameLimit} символов)" ${canCreate?"":"disabled"}>
      <button type="button" class="btn" onclick="createPlaylist()" ${canCreate?"":"disabled"}>${canCreate?"Создать":"Лимит достигнут"}</button>
    </div>
  </div>`;
  box.innerHTML=html;
}
function createPlaylist(){
  const u=currentUser();
  const input=document.getElementById("newPlaylistName");
  const name=(input&&input.value||"").trim();
  if(!name){alert("Введите название плейлиста.");return}
  const list=getPlaylists();
  const limit=playlistLimit(u);
  if(list.length>=limit){
    alert(`Лимит плейлистов для вашей роли: ${limit}.`);
    return;
  }
  const max=playlistNameLimit(u);
  if(name.length>max){
    alert(`Название плейлиста может содержать максимум ${max} символов.`);
    return;
  }
  list.push({id:Date.now().toString(36),name:name.slice(0,max),tracks:[],cover:""});
  savePlaylists(list);
  input.value="";
  editPlaylist(list.length-1);
}
function renamePlaylist(i){
  const list=getPlaylists(),p=list[i];
  if(!p)return;
  const max=playlistNameLimit();
  const name=prompt(`Название плейлиста (до ${max} символов):`,p.name);
  if(name===null)return;
  const clean=name.trim();
  if(!clean)return;
  if(clean.length>max){
    alert(`Название плейлиста может содержать максимум ${max} символов.`);
    return;
  }
  list[i].name=clean.slice(0,max);
  savePlaylists(list);
}
function deletePlaylist(i){
  const list=getPlaylists();
  if(!list[i])return;
  if(!confirm("Удалить этот плейлист?"))return;
  list.splice(i,1);
  savePlaylists(list);
}
function changePlaylistCover(i,event){
  const u=currentUser();
  if(!canUseVipPlaylistFeatures(u)){
    alert("Обложка плейлиста доступна только VIP и выше.");
    if(event?.target)event.target.value="";
    return;
  }
  const file=event?.target?.files?.[0];
  if(!file)return;
  const allowed=["image/png","image/jpeg","image/webp"];
  if(!allowed.includes(file.type)){
    alert("Обложка должна быть PNG, JPG или WEBP.");
    event.target.value="";
    return;
  }
  if(file.size>2*1024*1024){
    alert("Обложка слишком большая. Максимум 2 МБ.");
    event.target.value="";
    return;
  }
  const reader=new FileReader();
  reader.onload=()=>{
    const list=getPlaylists(),p=list[i];
    if(!p)return;
    p.cover=String(reader.result||"");
    savePlaylists(list);
    editPlaylist(i);
    event.target.value="";
  };
  reader.readAsDataURL(file);
}
function removePlaylistCover(i){
  if(!canUseVipPlaylistFeatures()){
    alert("Обложка плейлиста доступна только VIP и выше.");
    return;
  }
  const list=getPlaylists(),p=list[i];
  if(!p)return;
  p.cover="";
  savePlaylists(list);
  editPlaylist(i);
}
function editPlaylist(i){
  const list=getPlaylists(),p=list[i];
  if(!p)return;
  const box=document.getElementById("homePlaylists");
  if(!box)return;
  const old=document.getElementById("playlistEditor");
  if(old)old.remove();

  const vip=canUseVipPlaylistFeatures();
  const max=playlistNameLimit();
  const coverHtml=vip
    ? `<div class="playlist-cover-editor">
         <div class="playlist-cover-preview">${p.cover?`<img src="${esc(p.cover)}" alt="">`:`<span>♫</span>`}</div>
         <div class="playlist-cover-controls">
           <label class="section" style="margin:0 0 7px">ОБЛОЖКА ПЛЕЙЛИСТА · VIP</label>
           <input type="file" accept="image/png,image/jpeg,image/webp" onchange="changePlaylistCover(${i},event)">
           ${p.cover?`<button type="button" class="btn secondary" onclick="removePlaylistCover(${i})">Удалить обложку</button>`:""}
         </div>
       </div>`
    : `<div class="playlist-vip-lock">Обложка плейлиста доступна только VIP.</div>`;

  const editor=document.createElement("div");
  editor.id="playlistEditor";
  editor.className="panel playlist-editor";
  editor.innerHTML=`<div class="library-collection-head">
      <h2 style="margin:0">Настройка: ${esc(p.name)}</h2>
      <button class="btn secondary" type="button" onclick="document.getElementById('playlistEditor').remove()">Закрыть</button>
    </div>
    <div class="playlist-name-edit">
      <label class="section" style="margin:12px 0 7px">НАЗВАНИЕ · ${max} СИМВОЛОВ</label>
      <input id="playlistEditName" maxlength="${max}" value="${esc(p.name)}">
      <button type="button" class="btn secondary" style="margin-top:8px" onclick="savePlaylistName(${i})">Сохранить название</button>
    </div>
    ${coverHtml}
    <div class="playlist-track-list">${audioTracks.filter(t=>t.type==='server').map(t=>{
      const active=p.tracks.includes(t.key);
      return `<div class="playlist-track-choice"><div><b>${esc(t.title)}</b><small>${esc(t.artist||"")}</small></div><button type="button" class="btn ${active?"secondary":""}" onclick="togglePlaylistTrack(${i},'${esc(t.key).replace(/'/g,"&#39;")}')">${active?"Убрать":"Добавить"}</button></div>`;
    }).join("")}</div>`;
  box.appendChild(editor);
}
function savePlaylistName(i){
  const list=getPlaylists(),p=list[i];
  if(!p)return;
  const input=document.getElementById("playlistEditName");
  const name=(input?.value||"").trim();
  const max=playlistNameLimit();
  if(!name){alert("Введите название плейлиста.");return}
  if(name.length>max){alert(`Название плейлиста может содержать максимум ${max} символов.`);return}
  p.name=name;
  savePlaylists(list);
  editPlaylist(i);
}
function togglePlaylistTrack(i,key){
  const list=getPlaylists(),p=list[i];
  if(!p)return;
  const idx=p.tracks.indexOf(key);
  if(idx>=0)p.tracks.splice(idx,1);
  else p.tracks.push(key);
  savePlaylists(list);
  editPlaylist(i);
}
function playPlaylist(i){
  const p=getPlaylists()[i];
  if(!p)return;
  const tracks=p.tracks.map(getTrackByKey).filter(Boolean);
  if(!tracks.length){alert("В плейлисте пока нет треков.");return}
  playTrack(tracks[0],0);
  audioState.playlistQueue=tracks;
}
function renderHomePopular(){
  const box=document.getElementById("homePopular");
  if(!box)return;

  apiFetch("/api/popular?limit=8",{credentials:"same-origin",cache:"no-store"})
    .then(r=>{
      if(!r.ok)throw new Error("popular HTTP "+r.status);
      return r.json();
    })
    .then(d=>{
      const items=Array.isArray(d.popular)?d.popular:[];
      box.innerHTML=items.length
        ?items.map(t=>{
            const local=getTrackByKey(t.trackKey);
            const track=local||{key:t.trackKey,title:t.title,artist:t.artist,type:"server"};
            return homeTrackRow(
              track,
              `<span class="play-count">${Number(t.playCount)||0} ${Number(t.playCount)===1?"прослушивание":"прослушиваний"}</span>`
            );
          }).join("")
        :"<div class='home-list-empty'>Пока никто не слушал треки.</div>";
    })
    .catch(()=>{
      /* Не стираем уже показанные данные из-за краткого обрыва сети. */
      if(!box.innerHTML.trim()){
        box.innerHTML="<div class='home-list-empty'>Не удалось обновить список прослушиваний.</div>";
      }
    });
}
function refreshHome(){renderHomePlaylists();renderHomeRecent();renderHomePopular()}

function show(id,btn){
  if(id==="home"){refreshHome();}
  if(id==="library"){renderLibrary();renderSearchResults();}
  if(id==="search"){renderSearchResults();}
  if(id==="artists"){renderArtists();closeArtistDetail();}
  document.querySelectorAll(".screen").forEach(x=>x.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  document.querySelectorAll("nav button").forEach(x=>x.classList.remove("active"));
  if(btn)btn.classList.add("active");
  addLog("Открыт раздел: "+id);
}
const audioState={
  ctx:null,gain:null,source:null,localAudio:null,playing:false,startedAt:0,offset:0,
  duration:36,trackIndex:0,raf:null,volume:.8,currentKey:"demo:Cyberpunk Beats",hasSelectedTrack:false
};
const audioTracks=[
  {key:"demo:Cyberpunk Beats",title:"Cyberpunk Beats",artist:"Synth Wave",type:"demo",seed:1,duration:36},
  {key:"demo:Night Drive",title:"Night Drive",artist:"Dark Ambient",type:"demo",seed:2,duration:36},

  /* Каталог Red Music. Файлы должны находиться на общем сервере в public/music/. */
  {key:"server:lil-peep-your-favorite-dress",title:"Your Favorite Dress",artist:"Lil Peep • Lil Tracy",artistGroup:"Lil Peep",type:"server",dataUrl:"/music/lil-peep-your-favorite-dress.mp3"},
  {key:"server:lil-peep-star-shopping",title:"Star Shopping",artist:"Lil Peep",artistGroup:"Lil Peep",type:"server",dataUrl:"/music/lil-peep-star-shopping.mp3"},
  {key:"server:lil-peep-save-that-shit",title:"Save That Shit",artist:"Lil Peep",artistGroup:"Lil Peep",type:"server",dataUrl:"/music/lil-peep-save-that-shit.mp3"},
  {key:"server:lil-peep-ghost-boy",title:"Ghost Boy",artist:"Lil Peep",artistGroup:"Lil Peep",type:"server",dataUrl:"/music/lil-peep-ghost-boy.mp3"},
  {key:"server:lil-peep-castles",title:"Castles",artist:"Lil Tracy",artistGroup:"Lil Peep",type:"server",dataUrl:"/music/lil-peep-castles.mp3"},
  {key:"server:lil-peep-live-forever",title:"Live Forever",artist:"Lil Peep",artistGroup:"Lil Peep",type:"server",dataUrl:"/music/lil-peep-live-forever.mp3"},
  {key:"server:lil-peep-right-here",title:"Right Here",artist:"Lil Peep",artistGroup:"Lil Peep",type:"server",dataUrl:"/music/lil-peep-right-here.mp3"},
  {key:"server:lil-peep-witchblades",title:"Witchblades",artist:"Lil Peep • Lil Tracy",artistGroup:"Lil Peep",type:"server",dataUrl:"/music/lil-peep-witchblades.mp3"},
  {key:"server:lil-peep-ghost-girl",title:"Ghost Girl",artist:"Lil Peep",artistGroup:"Lil Peep",type:"server",dataUrl:"/music/lil-peep-ghost-girl.mp3"},
  {key:"server:lil-peep-nuts",title:"Nuts",artist:"Lil Peep",artistGroup:"Lil Peep",type:"server",dataUrl:"/music/lil-peep-nuts.mp3"},

  /* XXXTENTACION. Название исполнителя оформлено в официальном написании. */
  {key:"server:xxxtentacion-hope",title:"Hope",artist:"XXXTENTACION",artistGroup:"XXXTENTACION",type:"server",dataUrl:"/music/xxxtentacion-hope.mp3"},
  {key:"server:xxxtentacion-revenge",title:"Revenge",artist:"XXXTENTACION",artistGroup:"XXXTENTACION",type:"server",dataUrl:"/music/xxxtentacion-revenge.mp3"},
  {key:"server:falling-down-lil-peep-xxxtentacion",title:"Falling Down",artist:"Lil Peep • XXXTENTACION",artistGroups:["Lil Peep","XXXTENTACION"],artistGroup:"XXXTENTACION",type:"server",dataUrl:"/music/falling-down-lil-peep-xxxtentacion.mp3"},
  {key:"server:xxxtentacion-fuck-love",title:"Fuck Love",artist:"XXXTENTACION",artistGroup:"XXXTENTACION",type:"server",dataUrl:"/music/xxxtentacion-fuck-love.mp3"},
  {key:"server:xxxtentacion-joselyn-flores",title:"Jocelyn Flores",artist:"XXXTENTACION",artistGroup:"XXXTENTACION",type:"server",dataUrl:"/music/xxxtentacion-joselyn-flores.mp3"},
  {key:"server:xxxtentacion-save-me",title:"Save Me",artist:"XXXTENTACION",artistGroup:"XXXTENTACION",type:"server",dataUrl:"/music/xxxtentacion-save-me.mp3"},
  {key:"server:xxxtentacion-bad",title:"bad!",artist:"XXXTENTACION",artistGroup:"XXXTENTACION",type:"server",dataUrl:"/music/xxxtentacion-bad.mp3"},
  {key:"server:xxxtentacion-carry-on",title:"carry on",artist:"XXXTENTACION",artistGroup:"XXXTENTACION",type:"server",dataUrl:"/music/xxxtentacion-carry-on.mp3"},
  {key:"server:xxxtentacion-numb",title:"NUMB",artist:"XXXTENTACION",artistGroup:"XXXTENTACION",type:"server",dataUrl:"/music/xxxtentacion-numb.mp3"},
  {key:"server:xxxtentacion-sad",title:"SAD!",artist:"XXXTENTACION",artistGroup:"XXXTENTACION",type:"server",dataUrl:"/music/xxxtentacion-sad.mp3"},
  {key:"server:valentin-strykalo-rustem",title:"Рустем",artist:"Валентин Стрыкало",artistGroup:"Валентин Стрыкало",type:"server",dataUrl:"/music/valentin-strykalo-rustem.mp3"},
  {key:"server:valentin-strykalo-ty-ne-takaya",title:"Ты Не Такая",artist:"Валентин Стрыкало",artistGroup:"Валентин Стрыкало",type:"server",dataUrl:"/music/valentin-strykalo-ty-ne-takaya.mp3"},
  {key:"server:valentin-strykalo-vse-moi-druzya",title:"Все Мои Друзья",artist:"Валентин Стрыкало",artistGroup:"Валентин Стрыкало",type:"server",dataUrl:"/music/valentin-strykalo-vse-moi-druzya.mp3"},
  {key:"server:valentin-strykalo-otel-kooperator",title:"Отель Кооператор",artist:"Валентин Стрыкало",artistGroup:"Валентин Стрыкало",type:"server",dataUrl:"/music/valentin-strykalo-otel-kooperator.mp3"},
  {key:"server:valentin-strykalo-vsyo-resheno",title:"Всё решено",artist:"Валентин Стрыкало",artistGroup:"Валентин Стрыкало",type:"server",dataUrl:"/music/valentin-strykalo-vsyo-resheno.mp3"},
  {key:"server:valentin-strykalo-ty-pomnish",title:"Ты Помнишь",artist:"Валентин Стрыкало",artistGroup:"Валентин Стрыкало",type:"server",dataUrl:"/music/valentin-strykalo-ty-pomnish.mp3"},
  {key:"server:valentin-strykalo-kosmos",title:"Космос",artist:"Валентин Стрыкало",artistGroup:"Валентин Стрыкало",type:"server",dataUrl:"/music/valentin-strykalo-kosmos.mp3"},
  {key:"server:valentin-strykalo-na-kayene",title:"На Кайене",artist:"Валентин Стрыкало",artistGroup:"Валентин Стрыкало",type:"server",dataUrl:"/music/valentin-strykalo-na-kayene.mp3"},
  {key:"server:valentin-strykalo-tantsy",title:"Танцы",artist:"Валентин Стрыкало",artistGroup:"Валентин Стрыкало",type:"server",dataUrl:"/music/valentin-strykalo-tantsy.mp3"},
  {key:"server:valentin-strykalo-osen",title:"Осень",artist:"Валентин Стрыкало",artistGroup:"Валентин Стрыкало",type:"server",dataUrl:"/music/valentin-strykalo-osen.mp3"},
  {key:"server:madk1d-temnyy-princ-ty-che-obidelas",title:"тёмный принц, ты че обиделась",artist:"madk1d",artistGroup:"madk1d",type:"server",dataUrl:"/music/madk1d-temnyy-princ-ty-che-obidelas.mp3"},
  {key:"server:madk1d-1-maya",title:"1 мая",artist:"madk1d",artistGroup:"madk1d",type:"server",dataUrl:"/music/madk1d-1-maya.mp3"},
  {key:"server:madk1d-tancor",title:"танцор",artist:"madk1d",artistGroup:"madk1d",type:"server",dataUrl:"/music/madk1d-tancor.mp3"},
  {key:"server:madk1d-cena",title:"цена",artist:"madk1d",artistGroup:"madk1d",type:"server",dataUrl:"/music/madk1d-cena.mp3"},
  {key:"server:madk1d-sexyswag2010",title:"sexyswag2010",artist:"madk1d",artistGroup:"madk1d",type:"server",dataUrl:"/music/madk1d-sexyswag2010.mp3"},
  {key:"server:madk1d-dyrki-v-shtanah",title:"дырки в штанах",artist:"madk1d",artistGroup:"madk1d",type:"server",dataUrl:"/music/madk1d-dyrki-v-shtanah.mp3"},
  {key:"server:madk1d-martine-rose",title:"MARTINE ROSE",artist:"madk1d",artistGroup:"madk1d",type:"server",dataUrl:"/music/madk1d-martine-rose.mp3"},
  {key:"server:madk1d-always",title:"Always",artist:"madk1d",artistGroup:"madk1d",type:"server",dataUrl:"/music/madk1d-always.mp3"},
  {key:"server:madk1d-8-milya",title:"8 миля",artist:"madk1d",artistGroup:"madk1d",type:"server",dataUrl:"/music/madk1d-8-milya.mp3"},
  {key:"server:madk1d-tolpy",title:"Толпы",artist:"madk1d",artistGroup:"madk1d",type:"server",dataUrl:"/music/madk1d-tolpy.mp3"},
];

function fmtTime(sec){sec=Math.max(0,Math.floor(sec||0));return Math.floor(sec/60)+":"+String(sec%60).padStart(2,"0")}
function ensureAudio(){
  if(audioState.ctx)return;
  const C=window.AudioContext||window.webkitAudioContext;
  if(!C){alert("Браузер не поддерживает Web Audio.");return}
  audioState.ctx=new C();
  audioState.gain=audioState.ctx.createGain();
  audioState.gain.gain.value=audioState.volume;
  audioState.gain.connect(audioState.ctx.destination);
}
function makeDemoBuffer(track){
  const ctx=audioState.ctx, sr=ctx.sampleRate, len=Math.floor(track.duration*sr);
  const b=ctx.createBuffer(2,len,sr);
  for(let ch=0;ch<2;ch++){
    const d=b.getChannelData(ch);
    for(let i=0;i<len;i++){
      const t=i/sr, fade=Math.min(1,t/0.04,(track.duration-t)/0.12);
      let x=0;
      if(track.seed===1){
        const notes=[110,130.81,146.83,164.81,146.83,130.81,98,123.47];
        const n=notes[Math.floor(t*2)%notes.length];
        x=.16*Math.sin(2*Math.PI*n*t)+.07*Math.sin(2*Math.PI*n*2*t)+.025*Math.sin(2*Math.PI*55*t);
        if(Math.floor(t*4)%4===0)x+=.035*Math.sin(2*Math.PI*880*t)*Math.exp(-((t%0.25)*35));
      }else{
        const notes=[82.41,98,110,123.47,110,98,73.42,87.31];
        const n=notes[Math.floor(t*1.5)%notes.length];
        x=.14*Math.sin(2*Math.PI*n*t)+.05*Math.sin(2*Math.PI*(n/2)*t)+.018*Math.sin(2*Math.PI*220*t);
      }
      d[i]=x*fade;
    }
  }
  return b;
}

/* Red Music: Android lock-screen / notification media controls.
   Uses the browser/WebView Media Session API. This is the web-side bridge
   used by Android Chrome/Capacitor WebView for lock-screen controls. */
function mediaSessionSupported(){
  return typeof navigator !== "undefined" &&
         "mediaSession" in navigator &&
         typeof window.MediaMetadata !== "undefined";
}

function mediaArtworkUrl(tr){
  try{
    const candidate = tr && (tr.cover || tr.coverUrl || tr.artwork || tr.image);
    return candidate ? new URL(candidate, window.location.href).href
                     : new URL("logo.png", window.location.href).href;
  }catch(e){
    return new URL("logo.png", window.location.href).href;
  }
}

function updateMediaSession(tr){
  if(!tr)return;
  try{ if(window.__RMNativeMediaSync) window.__RMNativeMediaSync(tr); }catch(e){}
  if(!mediaSessionSupported())return;
  try{
    const artwork=mediaArtworkUrl(tr);
    navigator.mediaSession.metadata=new MediaMetadata({
      title:String(tr.title || "Без названия"),
      artist:String(tr.artist || "Red Music"),
      album:"Red Music",
      artwork:[
        {src:artwork,sizes:"192x192",type:"image/png"},
        {src:artwork,sizes:"512x512",type:"image/png"}
      ]
    });
    navigator.mediaSession.playbackState=audioState.playing ? "playing" : "paused";
    updateMediaSessionPosition();
  }catch(e){
    console.warn("[Red Music] Media Session metadata:",e);
  }
}

function updateMediaSessionState(){
  try{ if(window.__RMNativeMediaState) window.__RMNativeMediaState(); }catch(e){}
  if(!mediaSessionSupported())return;
  try{
    navigator.mediaSession.playbackState=audioState.playing ? "playing" : "paused";
    updateMediaSessionPosition();
  }catch(e){}
}

function updateMediaSessionPosition(){
  try{ if(window.__RMNativeMediaState) window.__RMNativeMediaState(); }catch(e){}
  if(!mediaSessionSupported())return;
  const duration=Number(audioState.duration)||0;
  if(!Number.isFinite(duration) || duration<=0)return;
  let position=Number(audioState.offset)||0;
  if(audioState.localAudio && Number.isFinite(audioState.localAudio.currentTime)){
    position=audioState.localAudio.currentTime;
  }else if(audioState.playing && audioState.ctx){
    position=audioState.ctx.currentTime-audioState.startedAt;
  }
  position=Math.max(0,Math.min(duration,position));
  try{
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate:1,
      position
    });
  }catch(e){}
}

function initMediaSession(){
  try{ const n=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.RedMusicMedia; if(n&&typeof n.updatePlayback==="function") n.updatePlayback({playing:false,position:0,duration:Number(audioState.duration)||0}); }catch(e){}
  if(!mediaSessionSupported())return;

  const safe=(fn)=>()=>{try{fn()}catch(e){console.warn("[Red Music] media action:",e)}};

  const actions={
    play:safe(()=>{
      const tr=getTrackByKey(audioState.currentKey)||audioTracks[0];
      if(!tr)return;
      if(audioState.localAudio){
        audioState.localAudio.play().then(()=>{
          audioState.playing=true;
          updateAudioUI();tickAudio();
        }).catch(()=>{});
      }else{
        togglePlay();
      }
    }),
    pause:safe(()=>{
      if(audioState.localAudio){
        audioState.localAudio.pause();
        audioState.playing=false;
        audioState.offset=audioState.localAudio.currentTime||0;
        updateAudioUI();
      }else{
        togglePlay();
      }
    }),
    previoustrack:safe(()=>prevTrack()),
    nexttrack:safe(()=>nextTrack()),
    seekbackward:safe(()=>{
      const amount=10;
      const current=Number(audioState.offset)||0;
      seekAudio(Math.max(0,current-amount)/(Number(audioState.duration)||1)*100);
    }),
    seekforward:safe(()=>{
      const amount=10;
      const current=Number(audioState.offset)||0;
      seekAudio(Math.min(Number(audioState.duration)||current+amount,current+amount)/
        (Number(audioState.duration)||1)*100);
    }),
    stop:safe(()=>{
      if(audioState.localAudio){
        audioState.localAudio.pause();
        audioState.localAudio.currentTime=0;
      }
      stopSource();
      audioState.playing=false;
      audioState.offset=0;
      updateAudioUI();
    })
  };

  Object.entries(actions).forEach(([name,handler])=>{
    try{navigator.mediaSession.setActionHandler(name,handler)}catch(e){}
  });

  // Keep the system notification state correct when Android backgrounds
  // and restores the Capacitor WebView.
  document.addEventListener("visibilitychange",()=>{
    setTimeout(()=>{
      updateMediaSessionState();
      updateMediaSessionPosition();
    },0);
  });
  window.addEventListener("pagehide",()=>updateMediaSessionState());
  window.addEventListener("pageshow",()=>{
    updateMediaSessionState();
    updateMediaSessionPosition();
  });
}

let __rmNativeMediaTimer=null;
try{
  __rmNativeMediaTimer=setInterval(()=>{try{if(window.__RMNativeMediaState)window.__RMNativeMediaState();}catch(e){}},1000);
}catch(e){}

function stopSource(){
  if(audioState.source){
    try{audioState.source.stop()}catch(e){}
    try{audioState.source.disconnect()}catch(e){}
    audioState.source=null;
  }
}
function localTracks(){
  const u=currentUser();
  return (u&&Array.isArray(u.localTracks)?u.localTracks:[]).map(x=>({
    ...x,type:"local",key:"local:"+x.id
  }));
}
function allTracks(){return audioTracks.concat(localTracks())}
function getTrackByKey(key){return allTracks().find(x=>x.key===key)||null}
function setPlayerText(tr){
  document.getElementById("playerTitle").textContent=tr.title||"Без названия";
  document.getElementById("playerArtist").textContent=tr.artist||"Локальный файл";
  updateMediaSession(tr);
}
function stopLocal(){
  if(audioState.localAudio){
    try{audioState.localAudio.pause()}catch(e){}
    audioState.localAudio=null;
  }
}
function reportTrackPlay(tr){if(!tr||tr.type!=="server")return;apiFetch("/api/popular/play",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({trackKey:tr.key,title:tr.title,artist:tr.artist||""})}).then(()=>renderHomePopular()).catch(()=>{});}
function playDemoTrack(tr,offset=0){
  const playerEl=document.getElementById("audioPlayer");
  if(playerEl) playerEl.classList.remove("rm-no-track");
  audioState.hasSelectedTrack=true;
  ensureAudio(); if(!audioState.ctx)return;
  stopLocal(); stopSource();
  if(audioState.ctx.state==="suspended")audioState.ctx.resume();
  audioState.duration=tr.duration;
  audioState.offset=Math.max(0,Math.min(offset,tr.duration));
  const src=audioState.ctx.createBufferSource();
  src.buffer=makeDemoBuffer(tr); src.connect(audioState.gain);
  audioState.source=src;
  audioState.startedAt=audioState.ctx.currentTime-audioState.offset;
  audioState.playing=true;
  src.start(0,audioState.offset);
  src.onended=()=>{
    if(audioState.playing){
      audioState.playing=false;audioState.offset=0;
      updateAudioUI();
      if(audioState.startedAt && Math.abs(audioState.ctx.currentTime-audioState.startedAt-tr.duration)<1) nextTrack();
    }
  };
  audioState.currentKey=tr.key;
  setPlayerText(tr);
  rememberRecentTrack(tr);
  reportTrackPlay(tr);
  audioState.trackIndex=allTracks().findIndex(x=>x.key===tr.key);
  const u=currentUser();
  if(u){
    u.tracks=(u.tracks||0)+1;
    saveUsers(loadUsers().map(x=>x.id===u.id?u:x));
    state.tracks=u.tracks;
    document.getElementById("sTracks").textContent=u.tracks;
  }
  addLog("Прослушивание: "+tr.title+" • "+tr.artist);
  updateAudioUI();tickAudio();
}
function resolveMediaUrl(mediaPath){
  if(!mediaPath)return "";
  try{
    // Музыка всегда берётся с общего Red Music сервера.
    // Нельзя строить URL относительно window.location, потому что
    // Android Capacitor может открывать интерфейс из https://localhost.
    return new URL(mediaPath, RED_MUSIC_API_BASE + "/").href;
  }catch(e){
    console.error("[Red Music] Некорректный media URL:", mediaPath, e);
    return mediaPath;
  }
}

function playLocalTrack(tr,offset=0){
  const playerEl=document.getElementById("audioPlayer");
  if(playerEl) playerEl.classList.remove("rm-no-track");
  audioState.hasSelectedTrack=true;
  stopSource();stopLocal();
  const audio=new Audio();
  audio.preload="auto";
  audio.setAttribute("playsinline","");
  audio.setAttribute("webkit-playsinline","");
  audio.crossOrigin="anonymous";
  audio.src=resolveMediaUrl(tr.dataUrl);
  audio.volume=audioState.volume;
  audioState.localAudio=audio;
  audioState.currentKey=tr.key;
  audioState.trackIndex=allTracks().findIndex(x=>x.key===tr.key);
  audioState.playing=true;
  setPlayerText(tr);
  rememberRecentTrack(tr);
  reportTrackPlay(tr);
  audio.addEventListener("loadedmetadata",()=>{
    audioState.duration=Number.isFinite(audio.duration)?audio.duration:(tr.duration||0);
    audio.currentTime=Math.min(offset||0,audioState.duration||0);
    updateAudioUI();
  },{once:true});
  audio.addEventListener("timeupdate",updateAudioUI);
  audio.addEventListener("play",()=>{
    audioState.playing=true;
    updateMediaSession(tr);
    updateMediaSessionState();
    updateAudioUI();
  });
  audio.addEventListener("pause",()=>{
    audioState.playing=false;
    audioState.offset=audio.currentTime||audioState.offset||0;
    updateMediaSessionState();
    updateAudioUI();
  });
  audio.addEventListener("error",()=>{
    audioState.playing=false;
    audioState.offset=0;
    updateAudioUI();

    const code=audio.error ? audio.error.code : 0;
    console.error("[Red Music] Ошибка аудио:", {
      url: audio.src,
      code,
      mediaError: audio.error
    });

    if(code===4){
      alert("Файл этого трека не найден на сервере или его формат не поддерживается. Проверьте public/music на Render.");
    }else{
      alert("Не удалось загрузить трек с сервера. Проверьте интернет-соединение и наличие MP3-файла.");
    }
  });
  audio.addEventListener("ended",()=>{
    audioState.playing=false;audioState.offset=0;updateAudioUI();nextTrack();
  });
  audio.play().catch((err)=>{
    console.error("[Red Music] audio.play() отклонён:", err);
    audioState.playing=false;
    updateAudioUI();

    setTimeout(()=>{
      audio.play().then(()=>{
        audioState.playing=true;
        updateAudioUI();
        tickAudio();
      }).catch((retryErr)=>{
        console.error("[Red Music] Повторное воспроизведение не удалось:", retryErr);
        alert("Не удалось начать воспроизведение. Проверьте, что файл трека существует на сервере.");
      });
    },120);
  });
  addLog("Прослушивание локального файла: "+tr.title);
  updateAudioUI();tickAudio();
}
function playTrack(tr,offset=0){
  if(!tr)return;
  if(tr.type==="local" || tr.type==="server")playLocalTrack(tr,offset);
  else playDemoTrack(tr,offset);
}
function play(t,a){
  const tr=audioTracks.find(x=>x.title===t) || {key:"demo:"+t,title:t,artist:a,type:"demo",seed:1,duration:36};
  playTrack(tr,0);
}
function togglePlay(){
  const tr=getTrackByKey(audioState.currentKey)||audioTracks[0];
  if(audioState.localAudio){
    if(audioState.localAudio.paused){
      audioState.localAudio.play().catch(()=>{});
      audioState.playing=true;
    }else{
      audioState.localAudio.pause();
      audioState.playing=false;
      audioState.offset=audioState.localAudio.currentTime;
    }
    updateAudioUI();tickAudio();return;
  }
  if(!audioState.source){playTrack(tr,audioState.offset||0);return}
  if(audioState.playing){
    audioState.offset=Math.min(audioState.duration,audioState.ctx.currentTime-audioState.startedAt);
    stopSource();audioState.playing=false;
  }else{
    playDemoTrack(tr,audioState.offset||0);
    return;
  }
  updateAudioUI();tickAudio();
}
function nextTrack(){
  const tracks=allTracks();
  if(!tracks.length)return;
  let i=tracks.findIndex(x=>x.key===audioState.currentKey);
  i=(i+1+tracks.length)%tracks.length;
  playTrack(tracks[i],0);
}
function prevTrack(){
  const tracks=allTracks();
  if(!tracks.length)return;
  let i=tracks.findIndex(x=>x.key===audioState.currentKey);
  i=(i-1+tracks.length)%tracks.length;
  playTrack(tracks[i],0);
}
function seekAudio(v){
  const target=(Number(v)/100)*audioState.duration;
  if(audioState.localAudio){
    audioState.localAudio.currentTime=Math.max(0,Math.min(target,audioState.localAudio.duration||target));
    audioState.offset=audioState.localAudio.currentTime;
    updateAudioUI();return;
  }
  const tr=getTrackByKey(audioState.currentKey)||audioTracks[0];
  audioState.offset=target;
  if(audioState.playing)playDemoTrack(tr,target);else updateAudioUI();
}
function setVolume(v){
  audioState.volume=Number(v);
  if(audioState.gain)audioState.gain.gain.value=audioState.volume;
  if(audioState.localAudio)audioState.localAudio.volume=audioState.volume;
}
function updatePlayerFavoriteUI(){
  const btn=document.getElementById("playerFavoriteBtn");
  if(!btn)return;

  const hasTrack=!!audioState.hasSelectedTrack && !!audioState.currentKey;
  btn.disabled=!hasTrack;

  if(!hasTrack){
    btn.classList.remove("active");
    btn.textContent="♡";
    btn.title="Нет выбранного трека";
    btn.setAttribute("aria-label","Нет выбранного трека");
    btn.setAttribute("aria-pressed","false");
    return;
  }

  const active=isFavorite(audioState.currentKey);
  btn.classList.toggle("active",active);
  btn.textContent=active?"♥":"♡";
  btn.title=active?"Убрать из любимых":"Добавить в любимые";
  btn.setAttribute("aria-label",active?"Убрать из любимых":"Добавить в любимые");
  btn.setAttribute("aria-pressed",active?"true":"false");
}

function toggleCurrentFavorite(event){
  if(event)event.stopPropagation();

  if(!audioState.hasSelectedTrack || !audioState.currentKey)return;

  const key=audioState.currentKey;
  const wasFavorite=isFavorite(key);

  toggleFavorite(key);

  const btn=document.getElementById("playerFavoriteBtn");
  if(btn){
    updatePlayerFavoriteUI();
    if(!wasFavorite){
      btn.classList.remove("like-pop");
      void btn.offsetWidth;
      btn.classList.add("like-pop");
    }
  }
}

function updateAudioUI(){
  const playerEl=document.getElementById("audioPlayer");
  if(playerEl) playerEl.classList.toggle("rm-no-track",!audioState.hasSelectedTrack);
  const btn=document.getElementById("playPauseBtn"),bar=document.getElementById("progressBar");
  if(!btn||!bar)return;
  let pos=audioState.offset||0;
  if(audioState.localAudio){
    pos=audioState.localAudio.currentTime||0;
    if(Number.isFinite(audioState.localAudio.duration))audioState.duration=audioState.localAudio.duration;
  }else if(audioState.playing&&audioState.ctx){
    pos=Math.max(0,Math.min(audioState.duration,audioState.ctx.currentTime-audioState.startedAt));
  }
  btn.textContent=audioState.playing?"⏸":"▶";
  updatePlayerFavoriteUI();
  updateMediaSessionState();
  refreshTrackPlayingIndicators();
  updateMediaSessionPosition();
  bar.value=audioState.duration?Math.min(100,pos/audioState.duration*100):0;
  document.getElementById("currentTime").textContent=fmtTime(pos);
  document.getElementById("durationTime").textContent=fmtTime(audioState.duration);
}
function tickAudio(){
  cancelAnimationFrame(audioState.raf);
  const loop=()=>{updateAudioUI();if(audioState.playing)audioState.raf=requestAnimationFrame(loop)};
  loop();
}

async function saveLocalAudio(e){
  const f=e.target.files&&e.target.files[0];
  if(!f)return;
  if(!f.type.startsWith("audio/")){alert("Выберите аудиофайл.");e.target.value="";return}
  const reader=new FileReader();
  reader.onload=()=>{
    const u=currentUser();if(!u)return;
    if(!Array.isArray(u.localTracks))u.localTracks=[];
    const id=Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,8);
    const title=f.name.replace(/\.[^/.]+$/,"");
    const tr={id,title,artist:"Локальный файл",mime:f.type,dataUrl:reader.result,added:new Date().toISOString()};
    u.localTracks.push(tr);
    saveUsers(loadUsers().map(x=>x.id===u.id?u:x));
    e.target.value="";
    renderLibrary();
    renderSearchResults();
    addLog("Добавлена локальная песня: "+title);
    playLocalTrack({...tr,key:"local:"+tr.id,type:"local"},0);
  };
  reader.readAsDataURL(f);
}
function removeLocalTrack(id){
  const u=currentUser();if(!u||!Array.isArray(u.localTracks))return;
  const tr=u.localTracks.find(x=>x.id===id);
  if(!tr)return;
  if(audioState.currentKey==="local:"+id){stopLocal();audioState.playing=false;audioState.currentKey="demo:Cyberpunk Beats";audioState.offset=0;updateAudioUI();}
  u.localTracks=u.localTracks.filter(x=>x.id!==id);
  saveUsers(loadUsers().map(x=>x.id===u.id?u:x));
  renderLibrary();renderSearchResults();addLog("Удалён локальный файл: "+tr.title);
}
function favoriteKeyForDemo(title){return "demo:"+title}
function isFavorite(key){
  const u=currentUser();return !!u&&Array.isArray(u.favorites)&&u.favorites.includes(key);
}
function toggleFavorite(key){
  const u=currentUser();if(!u)return;
  if(!Array.isArray(u.favorites))u.favorites=[];
  if(u.favorites.includes(key))u.favorites=u.favorites.filter(x=>x!==key);
  else u.favorites.push(key);
  u.likes=u.favorites.length;
  saveUsers(loadUsers().map(x=>x.id===u.id?u:x));
  state.likes=u.likes;
  document.getElementById("sLikes").textContent=u.likes;
  renderLibrary();renderSearchResults();
  addLog((u.favorites.includes(key)?"Добавлен в":"Удалён из")+" любимых");
}
function trackRow(tr,allowRemove=false){
  const fav=isFavorite(tr.key);
  const key=esc(tr.key).replace(/'/g,"&#39;");
  return `<div class="track" data-track-key="${esc(tr.key)}" data-search="${esc((tr.title+" "+(tr.artist||"")).toLowerCase())}" onclick="playTrack(getTrackByKey('${key}'))">
    <div class="track-info"><div class="track-icon">${tr.type==="local"?"🎵":"🎧"}</div>
      <div><b>${esc(tr.title)}</b><br><small>${esc(tr.artist||"Локальный файл")}</small></div>
    </div>
    <div class="library-track-actions">
      <button type="button" class="favorite-btn ${fav?"active":""}" onclick="event.stopPropagation();toggleFavorite('${key}')" title="Любимые">${fav?"♥":"♡"}</button>
      ${allowRemove?`<button type="button" class="remove-local-btn" onclick="event.stopPropagation();removeLocalTrack('${esc(tr.id).replace(/'/g,"&#39;")}')" title="Удалить файл">Удалить</button>`:""}
      <button type="button" class="track-play-indicator" onclick="event.stopPropagation();handleTrackIndicator('${key}')" aria-label="Играть" title="Играть">▶</button>
    </div>
  </div>`;
}
function renderLibrary(){
  const u=currentUser();if(!u)return;
  if(!Array.isArray(u.localTracks))u.localTracks=[];
  if(!Array.isArray(u.favorites))u.favorites=[];
  document.getElementById("favoritesCount").textContent=u.favorites.length;
  document.getElementById("localFilesCount").textContent=u.localTracks.length;
  const col=document.getElementById("libraryCollection");
  if(!col.classList.contains("hidden"))renderLibraryCollection(window.libraryCollection||"local");
}
function openLibraryCollection(kind){
  window.libraryCollection=kind;
  document.getElementById("libraryCollection").classList.remove("hidden");
  renderLibraryCollection(kind);
}
function closeLibraryCollection(){
  document.getElementById("libraryCollection").classList.add("hidden");
  window.libraryCollection=null;
}
function renderLibraryCollection(kind){
  const u=currentUser();if(!u)return;
  const title=document.getElementById("libraryCollectionTitle"),box=document.getElementById("libraryTracks");
  const addBtn=document.getElementById("localAddButton");
  if(addBtn) addBtn.style.display=kind==="local" ? "" : "none";
  if(kind==="favorites"){
    title.textContent="Любимые треки";
    const keys=Array.isArray(u.favorites)?u.favorites:[];
    const tracks=keys.map(getTrackByKey).filter(Boolean);
    box.innerHTML=tracks.length?tracks.map(t=>trackRow(t,t.type==="local")).join(""):"<div class='track'><small>В любимых пока ничего нет.</small></div>";
  }else{
    title.textContent="Локальные файлы";
    const tracks=localTracks();
    box.innerHTML=tracks.length?tracks.map(t=>trackRow(t,true)).join(""):"<div class='track'><small>Локальных песен пока нет. Добавьте файл кнопкой «Добавить локальную песню».</small></div>";
  }
}
function renderArtists(){
  const list=document.getElementById("artistList");
  if(!list)return;
  const groups={};
  audioTracks.filter(t=>t.type==="server").forEach(t=>{
    const names=Array.isArray(t.artistGroups) && t.artistGroups.length ? t.artistGroups : [t.artistGroup||t.artist||"Неизвестный исполнитель"];
    names.forEach(name=>{ (groups[name] ||= []).push(t); });
  });
  const names=Object.keys(groups);
  list.innerHTML=names.length ? names.map(name=>{
    const tracks=groups[name];
    const initial=esc(name.trim().charAt(0).toUpperCase());
    return `<button type="button" class="artist-card" onclick="openArtistDetail('${esc(name).replace(/'/g,"&#39;")}')">
      <span class="artist-avatar">${initial}</span>
      <span style="text-align:left"><b>${esc(name)}</b><small>${tracks.length} ${tracks.length===1?"трек":"треков"}</small></span>
    </button>`;
  }).join("") : "<div class='track'><small>Исполнители пока не добавлены.</small></div>";
}
function openArtistDetail(name){
  const tracks=audioTracks.filter(t=>t.type==="server" && (Array.isArray(t.artistGroups)?t.artistGroups:[t.artistGroup||t.artist]).includes(name));
  document.getElementById("artistList").classList.add("hidden");
  const detail=document.getElementById("artistDetail");
  detail.classList.remove("hidden");
  document.getElementById("artistDetailTitle").textContent=name;
  document.getElementById("artistTracks").innerHTML=tracks.length
    ? tracks.map(t=>trackRow(t,false)).join("")
    : "<div class='track'><small>Треков нет.</small></div>";
}
function closeArtistDetail(){
  document.getElementById("artistDetail").classList.add("hidden");
  document.getElementById("artistList").classList.remove("hidden");
}
function renderSearchResults(){
  const box=document.getElementById("localSearchResults");if(!box)return;
  const catalog=audioTracks.filter(t=>t.type==="server");
  box.innerHTML=catalog.map(t=>trackRow(t,false)).join("")+localTracks().map(t=>trackRow(t,false)).join("");
}
function handleTopSearch(e){
  if(e.key!=="Enter")return;
  const q=e.target.value.trim();
  show("search",document.querySelector('nav button[onclick*="\'search\'"]'));
  const input=document.querySelector("#search input");
  if(input)input.value=q;
  filterTracks(q);
}
function filterTracks(q){
  q=String(q||"").toLowerCase().trim();
  document.querySelectorAll("#results > .track").forEach(x=>{
    x.style.display=x.dataset.search.includes(q)?"flex":"none";
  });
  document.querySelectorAll("#localSearchResults .track").forEach(x=>{
    x.style.display=x.dataset.search.includes(q)?"flex":"none";
  });
}
function filterTracks(q){
  q=q.toLowerCase();
  document.querySelectorAll("#results .track").forEach(x=>x.style.display=x.dataset.search.includes(q)?"flex":"none");
}
function canUseVipAccent(u=currentUser()){
  if(!u)return false;
  const roles=getUserRoles(u).map(r=>String(r).toUpperCase());
  return roles.includes("VIP") || roles.includes("RUBY") || roles.includes("CO-CREATOR") || roles.includes("OWNER");
}
function refreshAccentChoices(){
  const u=currentUser();
  const unlocked=canUseVipAccent(u);
  document.querySelectorAll("[data-vip-accent]").forEach(el=>{
    el.classList.toggle("unlocked",unlocked);
    el.setAttribute("aria-disabled",unlocked?"false":"true");
  });
  const saved=localStorage.getItem("accent") || getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  document.querySelectorAll("[data-accent],[data-vip-accent]").forEach(el=>{
    const value=(el.dataset.accent||el.dataset.vipAccent||"").toLowerCase();
    el.classList.toggle("active",value===String(saved).toLowerCase());
  });
}
function migrateVipAccent(){
  try{
    const saved=(localStorage.getItem("accent")||"").toLowerCase();
    if(saved==="#e8e8e8" || saved==="#ffffff"){
      localStorage.setItem("accent","#111111");
      document.documentElement.style.setProperty("--accent","#111111");
    }
  }catch(e){}
}
function accent(v){
  const color=String(v||"").trim();
  if(!/^#[0-9a-fA-F]{6}$/.test(color))return;
  const vipColors=["#ff69b4","#111111","#ffd600"];
  if(vipColors.includes(color.toLowerCase()) && !canUseVipAccent()){
    alert("Этот цвет доступен только VIP и выше.");
    return;
  }
  document.documentElement.style.setProperty("--accent",color);
  localStorage.setItem("accent",color);
  refreshAccentChoices();
  addLog("Изменён акцентный цвет");
}
function selectVipAccent(el){
  const color=el?.dataset?.vipAccent;
  if(!color)return;
  if(!canUseVipAccent()){
    alert("Этот цвет доступен только VIP и выше.");
    return;
  }
  accent(color);
}
function updateCounter(inputId,counterId,max){
  const input=document.getElementById(inputId),counter=document.getElementById(counterId); if(!input||!counter)return;
  if(input.value.length>max)input.value=input.value.slice(0,max); counter.textContent=input.value.length+"/"+max;
}
function changeAvatar(event){
  const file=event.target.files&&event.target.files[0];
  if(!file)return;
  const allowed=["image/png","image/jpeg","image/webp","image/gif"];
  if(!allowed.includes(file.type)){
    alert("Можно использовать GIF-ава только с VIP");event.target.value="";return;
  }
  const vip=canUseVipPlaylistFeatures();
  if(file.type==="image/gif"){
    if(!vip){
      alert("GIF-аватарки доступны только VIP и выше.");
      event.target.value="";return;
    }
    if(file.size>8*1024*1024){
      alert("GIF-аватар слишком большой. Максимум 8 МБ.");
      event.target.value="";return;
    }
    const reader=new FileReader();
    reader.onload=()=>{
      const u=currentUser();if(!u)return;
      u.avatar=String(reader.result);u.avatarShape="circle";
      saveUsers(loadUsers().map(x=>Number(x.id)===Number(u.id)?u:x));
      updateUserUI();syncProfileToServer(u);addLog("Установлен GIF-аватар");
      event.target.value="";
    };
    reader.readAsDataURL(file);
    return;
  }
  if(file.size>5*1024*1024){
    alert("Изображение слишком большое. Максимум 5 МБ.");
    event.target.value="";return;
  }
  const reader=new FileReader();
  reader.onload=()=>{
    openAvatarCropper(String(reader.result),file.type);
    event.target.value="";
  };
  reader.readAsDataURL(file);
}
function removeAvatar(){
  const u=currentUser(); if(!u)return;
  if(!u.avatar){alert("У пользователя сейчас нет загруженной аватарки.");return}
  if(!confirm("Удалить текущую аватарку?"))return;
  u.avatar="";
  saveUsers(loadUsers().map(x=>x.id===u.id?u:x));
  updateUserUI(); syncProfileToServer(u); addLog("Удалена аватарка"); 
}
function saveProfile(){
  const u=currentUser(); if(!u)return;
  const name=document.getElementById("profileName").value.trim(),bio=document.getElementById("bio").value;
  if(name.length<2){alert("Ник должен содержать минимум 2 символа.");return}
  if(isNameLimited(u) && name.length>10){alert("Для USER и VIP ник не может быть длиннее 10 символов.");return}
  if(isBioLimited(u) && bio.length>60){alert("Для USER и VIP описание не может быть длиннее 60 символов.");return}
  u.name=name;u.bio=isBioLimited(u)?bio.slice(0,60):bio;saveUsers(loadUsers().map(x=>x.id===u.id?u:x));updateUserUI();syncProfileToServer(u);addLog("Изменён профиль");alert("Профиль сохранён");
}
function randomCode(prefix=""){
  return (prefix||"VIP")+"-"+Math.random().toString(36).slice(2,7).toUpperCase()+"-"+Math.random().toString(36).slice(2,6).toUpperCase();
}
function createPromo(){
  const code=randomCode(document.getElementById("promoPrefix").value.trim());
  state.promos.push({code,days:7,used:0,created:new Date().toLocaleString("ru-RU")});
  renderPromos(); addLog("Создан промокод "+code); saveState();
}
function renderPromos(){
  const el=document.getElementById("promoList"); if(!el)return;
  el.innerHTML=state.promos.length?state.promos.map(p=>`<div class="promo"><span><b class="code">${esc(p.code)}</b><br><small>VIP: 7 дней • использован: ${p.used}</small></span><button class="btn secondary" onclick="navigator.clipboard.writeText('${esc(p.code)}');addLog('Скопирован промокод ${esc(p.code)}')">Копировать</button></div>`).join(""):"<div class='promo'><small>Промокодов пока нет.</small></div>";
}
function activatePromo(){
  const input=document.getElementById("promoInput"), code=input.value.trim().toUpperCase();
  const p=state.promos.find(x=>String(x.code??"").trim().toUpperCase()===code);
  if(!p){alert("Промокод недействителен или исчерпан");return}

  const used=Number(p.used ?? p.used_count ?? 0);
  const maxUsesRaw=p.maxUses ?? p.max_uses;
  const maxUses=maxUsesRaw===undefined || maxUsesRaw===null || maxUsesRaw==="" ? null : Number(maxUsesRaw);
  const exhausted=maxUses===null ? used>=1 : (Number.isFinite(maxUses) && used>=maxUses);
  if(!Number.isFinite(used) || used<0 || exhausted){
    alert("Промокод недействителен или исчерпан");return;
  }

  const u=currentUser(); if(!u)return;
  p.used=used+1;
  const end=new Date(Date.now()+7*86400000).toISOString();
  state.vipUntil=end; u.vipUntil=end;
  normalizeUserRoles(u);
  if(!u.roles.includes("VIP"))u.roles.push("VIP");
  normalizeUserRoles(u);
  saveUsers(loadUsers().map(x=>x.id===u.id?u:x));
  state.role=u.role;
  updateUserUI(); addLog("Активирован VIP-промокод "+p.code);
  input.value=""; renderPromos(); saveState();
  alert("VIP активирован на 7 дней");
}
function logout(){
  const modal=document.getElementById("rm-logout-modal");
  if(!modal)return;
  modal.classList.add("rm-open");
  modal.setAttribute("aria-hidden","false");
}
function closeLogoutConfirm(){
  const modal=document.getElementById("rm-logout-modal");
  if(!modal)return;
  modal.classList.remove("rm-open");
  modal.setAttribute("aria-hidden","true");
}
function confirmLogout(){
  closeLogoutConfirm();
  addLog("Выход из аккаунта");
  syncCurrentUser();
  localStorage.removeItem(sessionKey);
  document.getElementById("loginPassword").value="";
  showAuth();
}
document.addEventListener("keydown",function(e){
  if(e.key==="Escape")closeLogoutConfirm();
});
function init(){
  initMediaSession();
  loadState();
  const accentSaved=localStorage.getItem("accent"); if(accentSaved)document.documentElement.style.setProperty("--accent",accentSaved);
  loadUsers();
  const u=currentUser();
  if(u) enterApp(u); else showAuth();
  refreshAccentChoices();
  renderPromos(); renderLogs(); renderAdminUsers(); refreshHome();
}
init();

setInterval(()=>{
  try{
    const me=currentUser();
    const adminScreen=document.getElementById("admin");
    if(me && isOwner(me) && adminScreen && adminScreen.classList.contains("active")){
      loadAdminUsersFromServer();
    }
  }catch(e){ console.warn("Автообновление списка пользователей:",e); }
},10000);

/* RED_MUSIC_POPULAR_REALTIME
   "Самые прослушиваемые треки" берутся с общего сервера, а не из localStorage.
   Все устройства получают актуальные значения автоматически.
*/
let __redMusicPopularTimer=null;
function startRedMusicPopularRealtime(){
  if(__redMusicPopularTimer)return;
  __redMusicPopularTimer=setInterval(()=>{
    try{
      const me=currentUser();
      const appShell=document.getElementById("appShell");
      const home=document.getElementById("home");
      if(me && appShell && appShell.style.display!=="none" && home && home.classList.contains("active")){
        renderHomePopular();
      }
    }catch(e){}
  },5000);
}
startRedMusicPopularRealtime();

document.addEventListener("visibilitychange",()=>{
  if(!document.hidden){
    try{
      const home=document.getElementById("home");
      if(home && home.classList.contains("active"))renderHomePopular();
    }catch(e){}
  }
});

