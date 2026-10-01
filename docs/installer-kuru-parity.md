# LexCrew Doc インストーラ仕様（KURU と同じ利用者体験）

この文書は GURI 側で実装するための仕様です。参照実装は KURU の `installer/setup.nsi` と `installer/install.ps1` です。GURI はすでに Tauri 2 の NSIS（`src-tauri/tauri.conf.json` の `bundle.targets: ["nsis"]`、`src-tauri/windows/hooks.nsh`）なので、KURU 用の独自 `setup.nsi` と `install.ps1` は持ち込まない。

## 利用者に起きること

渡す相手は Word を使う人です。受け取る物は NSIS のセットアップ exe です。管理者権限は不要です。インストール先のフォルダ選択は出しません。

ウィザードは日本語です。確認は次の二つです。

- スタートメニュー画面。フォルダ名の既定は `LexCrew Doc`。「ショートカットを作成しない」でスタートメニューを作らない。入れ替え時は古い `GURI` フォルダの `GURI.lnk` とデスクトップの `GURI.lnk` を消す。
- 完了画面。「デスクトップショートカットを作成する」は既定オン。外すと作らない。「LexCrew Doc を起動する」も既定オン。外すと今は起動しない。ショートカット名は `LexCrew Doc.lnk`。

ショートカットの実体は Tauri が置く `GURI.exe` です。リンク先のパスはバージョンが上がっても同じにします。作り直さなくても起動できます。

ログイン時の起動は、インストール時に有効にします。完了画面の「今すぐ起動」とは別です。あとからトレイの「ログイン時に起動」で外せます。`hooks.nsh` の `NSIS_HOOK_POSTINSTALL` にある「Windows にログインしたとき GURI を起動しますか？」は外します。既定がいいえの質問が残ると、KURU と手順が分かれます。

## 持ち込まないもの

- KURU の `install.ps1` / `uninstall.ps1` / 独自 `setup.nsi`。COM の RegAsm と Outlook アドイン登録は GURI に無い。
- Outlook の `Resiliency\DisabledItems`、`CrashingAddinList`、`NotificationReminderAddinData` をフォルダごと消す処理。KURU の `install.ps1` にはあるが、他のアドインの無効化まで戻る。GURI は今も消していない。このまま維持する。
- インストール先の選択画面。
- WebView2 の自動ダウンロードをやめること。GURI は `webviewInstallMode: downloadBootstrapper` のまま。
- サイレントインストール（`/S`）の新規対応。
- タスクバーにピン留めしたショートカットの解除。
- 履歴データベースの移行処理。

## 登録

Word アドインの登録は、今の `registry::register_addin` のままにします。書くのは `HKCU\SOFTWARE\Microsoft\Office\16.0\Wef\Developer` の、このアドイン ID の値ひとつです。マニフェストの絶対パスを上書きします。他のアドインの値は消しません。

インストールとバージョンアップのたびに、この値を新しいマニフェストパスへ書き直します。利用者が Word の画面で設定する作業はありません。Word を開くとホームタブに LexCrew が出ます。

登録に失敗したときは、完了画面のあとで成功したように見せない。今の起動時ダイアログ（「Word アドインの登録に失敗しました。Word を閉じてから LexCrew Doc を開き直してください。」）を残します。

アンインストールは `registry::unregister_addin` で、同じ ID の値だけを消します。`--uninstall-hooks` はこの処理を続けて呼びます。

## バージョンアップ

新しいセットアップを同じユーザーで実行すると、入れ替えになります。事前のアンインストールは不要です。

置き換わるのはプログラム本体です。Tauri の現在ユーザー向けインストール先（生成物の `$INSTDIR`）を丸ごと新しいファイルにします。その前に、起動中の `GURI.exe` を止めます。`NSIS_HOOK_PREUNINSTALL` の `taskkill` と同じです。

残すもの。

- `%APPDATA%\GURI\history.db`
- `%APPDATA%\GURI` の証明書とログ

アプリと機能の表示バージョンは、そのセットアップの版（`tauri.conf.json` の `version`）に更新します。キーは今と同じ `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\GURI` です。

古いセットアップを新しいインストールの上から実行した場合も、プログラムファイルはその古い版に置き換わります。版の前後では止めません。

## アンインストール

消してよいのはインストール先、スタートメニューの `LexCrew Doc.lnk` と残っている `GURI.lnk`、デスクトップの同じ二つのショートカット、`HKCU\...\Run` の `GURI`、Word の WEF Developer にあるこのアドイン ID の値、`HKCU\Software\GURI` です。アンインストールキーは `Uninstall\GURI` のままです。

`%APPDATA%\GURI` は消しません。履歴削除のチェックボックスは置きません。

## 変えるファイル

- `src-tauri/windows/hooks.nsh`
  - `NSIS_HOOK_POSTINSTALL` の Yes/No を削除する。
  - インストール成功時にログイン起動を有効にする。実装は、既存の `StartAtLogin=1` を無条件で書き、初回起動の `apply_installer_autostart` に渡すか、フックから同等の Run 登録を書く。どちらか一方にする。両方書くと二重になる。
- `src-tauri/src/lib.rs` と `src-tauri/src/registry.rs`
  - ログイン起動を有効にする経路を、上のフックと一本化する。
  - `register_addin` / `unregister_addin` は、自分の ID 以外を消さないことを維持する。
- `README.md` の「インストーラ」
  - ログイン起動の既定がいいえ、という記述を、インストール時に有効でトレイから外せる、に更新する。
  - ショートカットはスタートメニュー画面と完了画面で確認する、と書く。

`src-tauri/tauri.conf.json` の次は維持する。`installMode: currentUser`、言語は日本語、`displayLanguageSelector: false`、`startMenuFolder: LexCrew Doc`、`productName` は `GURI`（インストール先とアンインストールキー）、`webviewInstallMode.downloadBootstrapper`。表示名は NSIS テンプレートの `DISPLAYNAME` です。

## 確認

- セットアップ exe をダブルクリックすると、管理者の昇格は出ない。
- スタートメニューを作らない選択ができる。デスクトップのチェックを外すと `LexCrew Doc.lnk` がデスクトップに無い。
- 完了画面で起動を外すと、その場ではトレイが出ない。ログオンし直すと起動する。
- 入れ直したあと `%APPDATA%\GURI\history.db` の更新日時が維持される。
- `Wef\Developer` には GURI の ID の値だけが書き換わり、隣の値は残る。
- `Resiliency\DisabledItems` がインストール前後で消えない。
- アンインストール後、Word の WEF から GURI の ID が消え、`%APPDATA%\GURI` は残る。
