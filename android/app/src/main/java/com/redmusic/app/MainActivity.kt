package com.redmusic.app

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.core.app.ActivityCompat
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(RedMusicMediaPlugin::class.java)
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 4101)
        }
    }
}
