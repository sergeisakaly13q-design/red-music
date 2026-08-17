package com.redmusic.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat.MediaStyle
import androidx.media.session.MediaButtonReceiver
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class RedMusicMediaService : Service() {
    private lateinit var session: MediaSessionCompat
    private lateinit var sessionActivity: PendingIntent
    private lateinit var audioManager: AudioManager
    private var focusRequest: AudioFocusRequest? = null
    private val executor = Executors.newSingleThreadExecutor()

    override fun onCreate() {
        super.onCreate()
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        createChannel()
        val intent = Intent(this, MainActivity::class.java)
        sessionActivity = PendingIntent.getActivity(this, 100, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        session = MediaSessionCompat(this, "RedMusicMediaSession")
        session.setSessionActivity(sessionActivity)
        session.setCallback(object : MediaSessionCompat.Callback() {
            override fun onPlay() {
                requestFocus(); dispatch("play"); updateState(true, currentPosition, duration)
            }
            override fun onPause() {
                dispatch("pause"); updateState(false, currentPosition, duration)
            }
            override fun onSkipToNext() { dispatch("next") }
            override fun onSkipToPrevious() { dispatch("previous") }
            override fun onSeekTo(pos: Long) { currentPosition = pos; dispatch("seek", pos) }
            override fun onStop() { dispatch("stop"); updateState(false, 0L, duration); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
        })
        session.isActive = true
        startForeground(NOTIFICATION_ID, buildNotification())
        synchronized(lock) { service = this }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!session.isActive) session.isActive = true
        return START_STICKY
    }

    private fun requestFocus() {
        if (Build.VERSION.SDK_INT >= 26) {
            if (focusRequest == null) {
                focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                    .setOnAudioFocusChangeListener { change -> if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) dispatch("pause") }
                    .build()
            }
            audioManager.requestAudioFocus(focusRequest!!)
        } else {
            @Suppress("DEPRECATION") audioManager.requestAudioFocus({ change -> if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) dispatch("pause") }, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
        }
    }

    private fun dispatch(action: String, position: Long = -1L) {
        RedMusicMediaPlugin.instance?.dispatchAction(action, position)
    }

    private fun buildNotification(bitmap: Bitmap? = null): Notification {
        val prev = MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS)
        val play = MediaButtonReceiver.buildMediaButtonPendingIntent(this, if (isPlaying) PlaybackStateCompat.ACTION_PAUSE else PlaybackStateCompat.ACTION_PLAY)
        val next = MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_SKIP_TO_NEXT)
        val b = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(com.redmusic.app.R.drawable.ic_music_notification)
            .setContentTitle(title)
            .setContentText(artist)
            .setContentIntent(sessionActivity)
            .setOngoing(isPlaying)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(NotificationCompat.Action(com.redmusic.app.R.drawable.ic_music_notification, "Previous", prev))
            .addAction(NotificationCompat.Action(com.redmusic.app.R.drawable.ic_music_notification, if (isPlaying) "Pause" else "Play", play))
            .addAction(NotificationCompat.Action(com.redmusic.app.R.drawable.ic_music_notification, "Next", next))
            .setStyle(MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0,1,2))
        if (bitmap != null) b.setLargeIcon(bitmap)
        return b.build()
    }

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() {
        synchronized(lock) { if (service === this) service = null }
        try { session.isActive = false; session.release() } catch (_: Exception) {}
        executor.shutdownNow()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "red_music_media"
        private const val NOTIFICATION_ID = 4102
        private val lock = Any()
        private var service: RedMusicMediaService? = null
        private var title = "Red Music"
        private var artist = "Музыкальный плеер"
        private var album = "Red Music"
        private var artwork = ""
        private var isPlaying = false
        private var currentPosition = 0L
        private var duration = 0L

        fun updateMetadata(t: String, a: String, al: String, art: String) {
            synchronized(lock) { title=t; artist=a; album=al; artwork=art; service?.applyMetadata(); service?.refreshNotification() }
        }
        fun updatePlayback(playing: Boolean, position: Double, dur: Double) {
            synchronized(lock) { isPlaying=playing; currentPosition=(position*1000).toLong(); duration=(dur*1000).toLong(); service?.updateState(playing,currentPosition,duration); service?.refreshNotification() }
        }
        fun clearSession() { synchronized(lock) { service?.stopForeground(STOP_FOREGROUND_REMOVE); service?.stopSelf() } }

        private fun startIfNeeded(context: Context) {
            val i=Intent(context, RedMusicMediaService::class.java)
            if(Build.VERSION.SDK_INT>=26) context.startForegroundService(i) else context.startService(i)
        }

        fun ensure(context: Context) { synchronized(lock) { if (service == null) startIfNeeded(context) } }
    }

    private fun applyMetadata() {
        if (!::session.isInitialized) return
        session.setMetadata(MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM_ART_URI, artwork)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, duration)
            .build())
    }

    private fun updateState(playing: Boolean, position: Long, dur: Long) {
        isPlaying=playing; currentPosition=position; duration=dur
        val state=if(playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        val actions=PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or PlaybackStateCompat.ACTION_SKIP_TO_NEXT or PlaybackStateCompat.ACTION_SEEK_TO
        session.setPlaybackState(PlaybackStateCompat.Builder().setActions(actions).setState(state,position,1f,System.currentTimeMillis()).build())
        applyMetadata()
    }

    private fun refreshNotification() {
        val nm=getSystemService(NotificationManager::class.java)
        if(artwork.isBlank()) { nm.notify(NOTIFICATION_ID, buildNotification()); return }
        executor.execute {
            val bm=loadBitmap(artwork)
            nm.notify(NOTIFICATION_ID, buildNotification(bm))
        }
    }

    private fun loadBitmap(url:String): Bitmap? {
        return try {
            val c=URL(url).openConnection() as HttpURLConnection
            c.connectTimeout=4000; c.readTimeout=5000; c.instanceFollowRedirects=true
            c.inputStream.use { BitmapFactory.decodeStream(it) }
        } catch (_:Exception) { null }
    }

    private fun createChannel() {
        if(Build.VERSION.SDK_INT>=26) {
            val nm=getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL_ID,"Red Music",NotificationManager.IMPORTANCE_LOW).apply { description="Управление воспроизведением Red Music"; setShowBadge(false) })
        }
    }
}
