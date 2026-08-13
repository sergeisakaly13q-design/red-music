package com.redmusic.app
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.annotation.CapacitorPlugin
@CapacitorPlugin(name = "RedMusicMedia")
class RedMusicMediaPlugin : Plugin() {
    override fun load() {
        instance = this
    }
    @com.getcapacitor.PluginMethod
    fun updateMetadata(call: PluginCall) {
        val title = call.getString("title") ?: "Red Music"
        val artist = call.getString("artist") ?: "Red Music"
        val album = call.getString("album") ?: "Red Music"
        val artwork = call.getString("artwork") ?: ""
        RedMusicMediaService.ensure(context)
        RedMusicMediaService.updateMetadata(title, artist, album, artwork)
        call.resolve()
    }
    @com.getcapacitor.PluginMethod
    fun updatePlayback(call: PluginCall) {
        val playing = call.getBoolean("playing", false) ?: false
        val position = call.getDouble("position", 0.0) ?: 0.0
        val duration = call.getDouble("duration", 0.0) ?: 0.0
        RedMusicMediaService.ensure(context)
        RedMusicMediaService.updatePlayback(playing, position, duration)
        call.resolve()
    }
    @com.getcapacitor.PluginMethod
    fun clear(call: PluginCall) {
        RedMusicMediaService.clearSession()
        call.resolve()
    }
    companion object {
        var instance: RedMusicMediaPlugin? = null
    }
    fun dispatchAction(action: String, position: Long = -1L) {
        val data = JSObject()
        data.put("action", action)
        if (position >= 0) data.put("position", position)
        try {
            bridge.webView.evaluateJavascript("window.__RMNativeMediaAction && window.__RMNativeMediaAction(${data.toString()});", null)
        } catch (_: Exception) {}
    }
}
