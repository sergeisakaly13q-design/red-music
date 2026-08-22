# Red Music iOS

The project uses Capacitor 6 for iOS. The iOS native project is generated with `npx cap add ios` on macOS because Xcode/CocoaPods are required.

## Local Mac build

```bash
npm install
npm install @capacitor/ios@6.2.1
npx cap add ios
npx cap sync ios
npx cap open ios
```

Open the project in Xcode, select the App target, set your Apple Developer Team and Bundle Identifier (`com.redmusic.app`), then build on an iPhone.

The GitHub Actions iOS job builds an unsigned iOS Simulator `.app`. A physical-device/App Store build requires Apple signing credentials and should be configured separately.
