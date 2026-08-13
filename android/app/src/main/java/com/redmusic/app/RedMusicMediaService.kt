package com.redmusic.app

import android.net.Uri
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * Native Android playback service for Red Music.
 * Media3 owns the ExoPlayer + MediaSession pair, so Android System UI,
 * lock screen, Bluetooth controls and external media controllers stay in sync.
 */
class RedMusicMediaService : MediaSessionService() {
    private lateinit var player: ExoPlayer
    private lateinit var mediaSession: MediaSession

    override fun onCreate() {
        super.onCreate()

        player = ExoPlayer.Builder(this)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                true
            )
            .setHandleAudioBecomingNoisy(true)
            .build()

        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                dispatchState()
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                dispatchState()
                if (playbackState == Player.STATE_ENDED) {
                    RedMusicMediaPlugin.instance?.dispatchAction("next")
                }
            }

            override fun onPositionDiscontinuity(
                oldPosition: Player.PositionInfo,
                newPosition: Player.PositionInfo,
                reason: Int
            ) {
                dispatchState()
            }

            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                RedMusicMediaPlugin.instance?.dispatchError(error.message ?: "Ошибка воспроизведения")
            }
        })

        mediaSession = MediaSession.Builder(this, player).build()
        synchronized(lock) { service = this }
        dispatchState()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession = mediaSession

    fun setTrack(
        url: String,
        title: String,
        artist: String,
        album: String,
        artwork: String,
        positionMs: Long,
        autoPlay: Boolean
    ) {
        val metadata = MediaMetadata.Builder()
            .setTitle(title)
            .setArtist(artist)
            .setAlbumTitle(album)
            .apply { if (artwork.isNotBlank()) setArtworkUri(Uri.parse(artwork)) }
            .build()

        val item = MediaItem.Builder()
            .setMediaId(title.ifBlank { "red-music-track" })
            .setUri(url)
            .setMediaMetadata(metadata)
            .build()

        player.setMediaItem(item, positionMs.coerceAtLeast(0L))
        player.prepare()
        player.playWhenReady = autoPlay
        dispatchState()
    }

    fun play() {
        player.play()
    }

    fun pause() {
        player.pause()
    }

    fun seekTo(positionMs: Long) {
        player.seekTo(positionMs.coerceAtLeast(0L))
    }

    fun stop() {
        player.stop()
        dispatchState()
    }

    fun setVolume(volume: Float) {
        player.volume = volume.coerceIn(0f, 1f)
    }

    fun dispatchState() {
        if (!::player.isInitialized) return
        RedMusicMediaPlugin.instance?.dispatchState(
            player.isPlaying,
            player.currentPosition,
            if (player.duration == C.TIME_UNSET) 0L else player.duration
        )
    }

    override fun onTaskRemoved(rootIntent: android.content.Intent?) {
        // Keep playback alive when the app task is swiped away while audio is playing.
        if (!player.isPlaying) stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        synchronized(lock) { if (service === this) service = null }
        if (::mediaSession.isInitialized) mediaSession.release()
        if (::player.isInitialized) player.release()
        super.onDestroy()
    }

    companion object {
        private val lock = Any()
        private var service: RedMusicMediaService? = null

        fun current(): RedMusicMediaService? = synchronized(lock) { service }
    }
}
