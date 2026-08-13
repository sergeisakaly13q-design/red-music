package com.redmusic.app

import android.content.ComponentName
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.common.util.concurrent.ListenableFuture

@CapacitorPlugin(name = "RedMusicMedia")
class RedMusicMediaPlugin : Plugin() {
    private var controller: MediaController? = null
    private var controllerFuture: ListenableFuture<MediaController>? = null

    override fun load() {
        instance = this
        connectController()
    }

    private fun connectController() {
        val token = SessionToken(requireContext(), ComponentName(requireContext(), RedMusicMediaService::class.java))
        controllerFuture = MediaController.Builder(requireContext(), token).buildAsync()
        controllerFuture?.addListener({
            try {
                controller = controllerFuture?.get()
            } catch (e: Exception) {
                dispatchError(e.message ?: "Не удалось подключиться к MediaSession")
            }
        }, requireActivity().mainExecutor)
    }

    private fun getController(): MediaController? {
        return controller ?: controllerFuture?.let {
            if (it.isDone) try { it.get() } catch (_: Exception) { null } else null
        }
    }

    private fun withController(call: PluginCall, action: (MediaController) -> Unit) {
        val ready = getController()
        if (ready != null) {
            action(ready)
            return
        }
        val future = controllerFuture
        if (future == null) {
            call.reject("MediaController не создан")
            return
        }
        future.addListener({
            try {
                val c = future.get()
                controller = c
                action(c)
            } catch (e: Exception) {
                call.reject("MediaController: ${e.message ?: "ошибка подключения"}")
            }
        }, requireActivity().mainExecutor)
    }

    @PluginMethod
    fun setTrack(call: PluginCall) {
        val url = call.getString("url") ?: ""
        if (url.isBlank()) {
            call.reject("URL трека пустой")
            return
        }
        withController(call) { c ->
            c.setMediaItem(
                androidx.media3.common.MediaItem.Builder()
                    .setMediaId(call.getString("id") ?: "red-music-track")
                    .setUri(url)
                    .setMediaMetadata(
                        androidx.media3.common.MediaMetadata.Builder()
                            .setTitle(call.getString("title") ?: "Red Music")
                            .setArtist(call.getString("artist") ?: "Red Music")
                            .setAlbumTitle(call.getString("album") ?: "Red Music")
                            .apply {
                                call.getString("artwork")?.takeIf { it.isNotBlank() }?.let { setArtworkUri(android.net.Uri.parse(it)) }
                            }
                            .build()
                    )
                    .build(),
                (call.getDouble("position", 0.0) * 1000.0).toLong().coerceAtLeast(0L)
            )
            c.prepare()
            if (call.getBoolean("autoPlay", true)) c.play() else c.pause()
            call.resolve()
        }
    }

    @PluginMethod
    fun play(call: PluginCall) {
        withController(call) { it.play(); call.resolve() }
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        withController(call) { it.pause(); call.resolve() }
    }

    @PluginMethod
    fun seekTo(call: PluginCall) {
        withController(call) {
            it.seekTo((call.getDouble("position", 0.0) * 1000.0).toLong().coerceAtLeast(0L))
            call.resolve()
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        withController(call) { it.stop(); call.resolve() }
    }

    @PluginMethod
    fun setVolume(call: PluginCall) {
        withController(call) {
            it.volume = call.getDouble("volume", 1.0).toFloat().coerceIn(0f, 1f)
            call.resolve()
        }
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        withController(call) {
            it.stop()
            it.clearMediaItems()
            call.resolve()
        }
    }

    @PluginMethod
    fun updateMetadata(call: PluginCall) {
        // Kept for compatibility with the existing Red Music web bridge.
        call.resolve()
    }

    @PluginMethod
    fun updatePlayback(call: PluginCall) {
        // Playback state is now owned by Media3/ExoPlayer. Do not continuously
        // overwrite it from WebView state, otherwise two players fight each other.
        call.resolve()
    }

    override fun handleOnDestroy() {
        try { controller?.release() } catch (_: Exception) {}
        controller = null
        controllerFuture = null
        if (instance === this) instance = null
        super.handleOnDestroy()
    }

    fun dispatchAction(action: String, position: Long = -1L) {
        val data = JSObject().put("action", action)
        if (position >= 0) data.put("position", position)
        dispatchToWebView("window.__RMNativeMediaAction", data.toString())
    }

    fun dispatchState(playing: Boolean, positionMs: Long, durationMs: Long) {
        val data = JSObject()
            .put("playing", playing)
            .put("position", positionMs / 1000.0)
            .put("duration", durationMs / 1000.0)
        dispatchToWebView("window.__RMNativeMediaStateChanged", data.toString())
    }

    fun dispatchError(message: String) {
        val data = JSObject().put("message", message)
        dispatchToWebView("window.__RMNativeMediaError", data.toString())
    }

    private fun dispatchToWebView(functionName: String, json: String) {
        try { bridge.webView.evaluateJavascript("$functionName && $functionName($json);", null) } catch (_: Exception) {}
    }

    companion object {
        var instance: RedMusicMediaPlugin? = null
    }
}
