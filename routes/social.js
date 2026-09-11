const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { createAntiSpam } = require('../middleware/antiSpam');

function clean(v, max=160){ return String(v ?? '').replace(/[\\u0000-\\u001F\\u007F]/g,'').trim().slice(0,max); }

module.exports = function createSocialRouter(db){
  const router=express.Router();
  const antiSpam=createAntiSpam({windowMs:60000,maxActions:40,cooldownMs:60000,keyPrefix:'social'});

  router.get('/search', requireAuth, (req,res)=>{
    const q=clean(req.query.q,50).toLowerCase();
    if(q.length<2) return res.json({users:[]});
    const like='%'+q+'%';
    const users=db.prepare(`SELECT id,username,display_name,bio,avatar_url,avatar_color FROM users WHERE banned=0 AND id<>? AND (lower(username) LIKE ? OR lower(display_name) LIKE ?) ORDER BY CASE WHEN lower(username)=? THEN 0 ELSE 1 END, display_name COLLATE NOCASE LIMIT 30`).all(req.userId,like,like,q);
    res.json({users});
  });

  router.get('/friends', requireAuth, (req,res)=>{
    const rows=db.prepare(`SELECT f.id,f.status,f.requester_id AS requesterId,f.addressee_id AS addresseeId,f.created_at AS createdAt,u.id AS userId,u.username,u.display_name,u.bio,u.avatar_url,u.avatar_color FROM friendships f JOIN users u ON u.id=CASE WHEN f.requester_id=? THEN f.addressee_id ELSE f.requester_id END WHERE (f.requester_id=? OR f.addressee_id=?) AND u.banned=0 ORDER BY datetime(f.updated_at) DESC`).all(req.userId,req.userId,req.userId);
    const incoming=rows.filter(x=>x.status==='pending' && Number(x.addresseeId)===Number(req.userId));
    const outgoing=rows.filter(x=>x.status==='pending' && Number(x.requesterId)===Number(req.userId));
    const friends=rows.filter(x=>x.status==='accepted');
    res.json({friends,incoming,outgoing});
  });

  router.post('/friends/request', requireAuth, antiSpam, (req,res)=>{
    const target=Number(req.body?.userId);
    if(!Number.isInteger(target)||target<1||target===req.userId) return res.status(400).json({error:'Некорректный пользователь'});
    const user=db.prepare('SELECT id FROM users WHERE id=? AND banned=0').get(target);
    if(!user) return res.status(404).json({error:'Пользователь не найден'});
    const a=Math.min(req.userId,target),b=Math.max(req.userId,target);
    const existing=db.prepare('SELECT * FROM friendships WHERE requester_id IN (?,?) AND addressee_id IN (?,?) AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))').get(a,b,a,b,req.userId,target,target,req.userId);
    if(existing){
      if(existing.status==='accepted') return res.json({ok:true,status:'accepted'});
      if(existing.status==='pending') return res.json({ok:true,status:existing.requester_id===req.userId?'pending':'incoming'});
      db.prepare('DELETE FROM friendships WHERE id=?').run(existing.id);
    }
    db.prepare(`INSERT INTO friendships(requester_id,addressee_id,status,updated_at) VALUES(?,?, 'pending',datetime('now'))`).run(req.userId,target);
    res.json({ok:true,status:'pending'});
  });

  router.post('/friends/respond', requireAuth, antiSpam, (req,res)=>{
    const id=Number(req.body?.requestId), action=clean(req.body?.action,20).toLowerCase();
    if(!Number.isInteger(id)||!['accept','decline','remove'].includes(action)) return res.status(400).json({error:'Некорректное действие'});
    const f=db.prepare('SELECT * FROM friendships WHERE id=?').get(id);
    if(!f || (Number(f.requester_id)!==req.userId && Number(f.addressee_id)!==req.userId)) return res.status(404).json({error:'Заявка не найдена'});
    if(action==='remove'){ db.prepare('DELETE FROM friendships WHERE id=?').run(id); return res.json({ok:true,status:'removed'}); }
    if(action==='accept' && Number(f.addressee_id)!==req.userId) return res.status(403).json({error:'Принять заявку может получатель'});
    if(action==='decline' && f.status!=='pending') return res.status(400).json({error:'Заявка уже обработана'});
    if(action==='accept') db.prepare("UPDATE friendships SET status='accepted',updated_at=datetime('now') WHERE id=?").run(id);
    else db.prepare('DELETE FROM friendships WHERE id=?').run(id);
    res.json({ok:true,status:action==='accept'?'accepted':'declined'});
  });

  router.get('/activity', requireAuth, (req,res)=>{
    const friendIds=db.prepare(`SELECT CASE WHEN requester_id=? THEN addressee_id ELSE requester_id END AS id FROM friendships WHERE status='accepted' AND (requester_id=? OR addressee_id=?)`).all(req.userId,req.userId,req.userId).map(x=>Number(x.id));
    if(!friendIds.length) return res.json({activity:[]});
    const placeholders=friendIds.map(()=>'?').join(',');
    const activity=db.prepare(`SELECT e.user_id AS userId,u.username,u.display_name AS displayName,e.title,e.artist,e.played_at AS playedAt FROM listening_events e JOIN users u ON u.id=e.user_id WHERE e.completed=1 AND e.user_id IN (${placeholders}) ORDER BY datetime(e.played_at) DESC,e.id DESC LIMIT 50`).all(...friendIds);
    res.json({activity});
  });

  router.post('/now-playing', requireAuth, antiSpam, (req,res)=>{
    const key=clean(req.body?.trackKey,180),title=clean(req.body?.title,160),artist=clean(req.body?.artist,160),playing=Boolean(req.body?.playing);
    if(!key) return res.status(400).json({error:'Не указан трек'});
    db.prepare(`INSERT INTO now_playing(user_id,track_key,title,artist,playing,updated_at) VALUES(?,?,?,?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET track_key=excluded.track_key,title=excluded.title,artist=excluded.artist,playing=excluded.playing,updated_at=datetime('now')`).run(req.userId,key,title,artist,playing?1:0);
    res.json({ok:true});
  });

  router.get('/now-playing', requireAuth, (req,res)=>{
    const rows=db.prepare(`SELECT n.user_id AS userId,u.username,u.display_name AS displayName,n.track_key AS trackKey,n.title,n.artist,n.playing,n.updated_at AS updatedAt FROM now_playing n JOIN users u ON u.id=n.user_id JOIN friendships f ON f.status='accepted' AND ((f.requester_id=? AND f.addressee_id=n.user_id) OR (f.addressee_id=? AND f.requester_id=n.user_id)) WHERE n.updated_at >= datetime('now','-2 minutes') ORDER BY datetime(n.updated_at) DESC`).all(req.userId,req.userId);
    res.json({nowPlaying:rows});
  });

  router.post('/send-track', requireAuth, antiSpam, (req,res)=>{
    const to=Number(req.body?.toUserId),key=clean(req.body?.trackKey,180),title=clean(req.body?.title,160),artist=clean(req.body?.artist,160);
    if(!Number.isInteger(to)||to<1||!key||!title) return res.status(400).json({error:'Некорректный трек или получатель'});
    const f=db.prepare(`SELECT id FROM friendships WHERE status='accepted' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))`).get(req.userId,to,to,req.userId);
    if(!f) return res.status(403).json({error:'Отправлять треки можно только друзьям'});
    const target=db.prepare('SELECT id FROM users WHERE id=? AND banned=0').get(to); if(!target) return res.status(404).json({error:'Получатель не найден'});
    db.prepare(`INSERT INTO shared_tracks(sender_id,receiver_id,track_key,title,artist,created_at) VALUES(?,?,?,?,?,datetime('now'))`).run(req.userId,to,key,title,artist);
    res.json({ok:true});
  });

  router.get('/shared-tracks', requireAuth, (req,res)=>{
    const rows=db.prepare(`SELECT s.id,s.sender_id AS senderId,s.receiver_id AS receiverId,s.track_key AS trackKey,s.title,s.artist,s.created_at AS createdAt,u.username AS senderUsername,u.display_name AS senderName FROM shared_tracks s JOIN users u ON u.id=s.sender_id WHERE s.receiver_id=? ORDER BY datetime(s.created_at) DESC LIMIT 50`).all(req.userId);
    res.json({tracks:rows});
  });

  router.get('/likes/:userId', requireAuth, (req,res)=>{
    const uid=Number(req.params.userId); if(!Number.isInteger(uid)||uid<1) return res.status(400).json({error:'Некорректный пользователь'});
    const allowed=uid===req.userId || !!db.prepare(`SELECT id FROM friendships WHERE status='accepted' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))`).get(req.userId,uid,uid,req.userId);
    if(!allowed) return res.status(403).json({error:'Лайки доступны друзьям'});
    const tracks=db.prepare(`SELECT t.id,t.title,t.artist,t.album,t.filename,t.mime_type FROM favorites f JOIN tracks t ON t.id=f.track_id WHERE f.user_id=? ORDER BY datetime(f.created_at) DESC LIMIT 100`).all(uid);
    res.json({tracks});
  });

  router.get('/playlists/public/:userId', requireAuth, (req,res)=>{
    const uid=Number(req.params.userId); if(!Number.isInteger(uid)||uid<1) return res.status(400).json({error:'Некорректный пользователь'});
    const allowed=uid===req.userId || !!db.prepare(`SELECT id FROM friendships WHERE status='accepted' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))`).get(req.userId,uid,uid,req.userId);
    if(!allowed) return res.status(403).json({error:'Плейлисты доступны друзьям'});
    const playlists=db.prepare(`SELECT p.id,p.name,p.updated_at AS updatedAt,COUNT(pt.id) AS trackCount FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id=p.id WHERE p.user_id=? AND p.is_public=1 GROUP BY p.id ORDER BY datetime(p.updated_at) DESC`).all(uid);
    for(const p of playlists) p.tracks=db.prepare(`SELECT pt.id,pt.title,pt.artist,pt.album,pt.track_key AS trackKey,pt.matched_track_id AS matchedTrackId FROM playlist_tracks pt WHERE pt.playlist_id=? ORDER BY pt.position`).all(p.id);
    res.json({playlists});
  });

  router.post('/playlists/visibility', requireAuth, antiSpam, (req,res)=>{
    const id=Number(req.body?.playlistId); if(!Number.isInteger(id)||id<1) return res.status(400).json({error:'Некорректный плейлист'});
    const pub=Boolean(req.body?.public); const info=db.prepare('UPDATE playlists SET is_public=?,updated_at=datetime(\'now\') WHERE id=? AND user_id=?').run(pub?1:0,id,req.userId);
    if(!info.changes)return res.status(404).json({error:'Плейлист не найден'}); res.json({ok:true,public:pub});
  });

  router.post('/playlists/collaborators', requireAuth, antiSpam, (req,res)=>{
    const pid=Number(req.body?.playlistId),uid=Number(req.body?.userId); if(!Number.isInteger(pid)||!Number.isInteger(uid)||pid<1||uid<1)return res.status(400).json({error:'Некорректные данные'});
    const owner=db.prepare('SELECT id FROM playlists WHERE id=? AND user_id=?').get(pid,req.userId); if(!owner)return res.status(404).json({error:'Плейлист не найден'});
    const friend=db.prepare(`SELECT id FROM friendships WHERE status='accepted' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))`).get(req.userId,uid,uid,req.userId); if(!friend)return res.status(403).json({error:'Добавлять можно только друзей'});
    db.prepare(`INSERT INTO playlist_collaborators(playlist_id,user_id,role) VALUES(?,?, 'editor') ON CONFLICT(playlist_id,user_id) DO UPDATE SET role='editor'`).run(pid,uid); res.json({ok:true});
  });

  router.get('/playlists/collaborators/:id', requireAuth, (req,res)=>{
    const pid=Number(req.params.id); const p=db.prepare('SELECT user_id FROM playlists WHERE id=?').get(pid); if(!p)return res.status(404).json({error:'Плейлист не найден'});
    const allowed=Number(p.user_id)===req.userId || !!db.prepare('SELECT 1 FROM playlist_collaborators WHERE playlist_id=? AND user_id=?').get(pid,req.userId); if(!allowed)return res.status(403).json({error:'Нет доступа'});
    const users=db.prepare(`SELECT c.user_id AS userId,u.username,u.display_name AS displayName,c.role FROM playlist_collaborators c JOIN users u ON u.id=c.user_id WHERE c.playlist_id=?`).all(pid); res.json({users});
  });


  router.post('/playlists/collab-track', requireAuth, antiSpam, (req,res)=>{
    const pid=Number(req.body?.playlistId), title=clean(req.body?.title,160), artist=clean(req.body?.artist,160), album=clean(req.body?.album,160), key=clean(req.body?.trackKey,180);
    if(!Number.isInteger(pid)||pid<1||!title)return res.status(400).json({error:'Некорректный трек или плейлист'});
    const p=db.prepare('SELECT id,user_id FROM playlists WHERE id=?').get(pid); if(!p)return res.status(404).json({error:'Плейлист не найден'});
    const allowed=Number(p.user_id)===req.userId || !!db.prepare("SELECT 1 FROM playlist_collaborators WHERE playlist_id=? AND user_id=? AND role='editor'").get(pid,req.userId);
    if(!allowed)return res.status(403).json({error:'Нет прав на редактирование'});
    const pos=Number(db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS p FROM playlist_tracks WHERE playlist_id=?').get(pid).p);
    db.prepare(`INSERT INTO playlist_tracks(playlist_id,position,title,artist,album,source,track_key) VALUES(?,?,?,?,?,'redmusic',?,?)`).run(pid,pos,title,artist,album,key);
    db.prepare("UPDATE playlists SET updated_at=datetime('now') WHERE id=?").run(pid); res.json({ok:true});
  });

  router.delete('/playlists/collab-track/:trackId', requireAuth, antiSpam, (req,res)=>{
    const tid=Number(req.params.trackId); if(!Number.isInteger(tid)||tid<1)return res.status(400).json({error:'Некорректный трек'});
    const row=db.prepare('SELECT pt.id,pt.playlist_id,p.user_id FROM playlist_tracks pt JOIN playlists p ON p.id=pt.playlist_id WHERE pt.id=?').get(tid); if(!row)return res.status(404).json({error:'Трек не найден'});
    const allowed=Number(row.user_id)===req.userId || !!db.prepare("SELECT 1 FROM playlist_collaborators WHERE playlist_id=? AND user_id=? AND role='editor'").get(row.playlist_id,req.userId); if(!allowed)return res.status(403).json({error:'Нет прав на редактирование'});
    db.prepare('DELETE FROM playlist_tracks WHERE id=?').run(tid); db.prepare("UPDATE playlists SET updated_at=datetime('now') WHERE id=?").run(row.playlist_id); res.json({ok:true});
  });

  return router;
};
