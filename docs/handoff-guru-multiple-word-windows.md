# GURU（LexCrew-Doc）引継ぎ — 複数 Word ウィンドウと作業ウィンドウ（タスクペイン）

LexCrew-Mail（Outlook）で v1.0.3 まで直した事象と同型の不具合が、複数の Word 画面を開いている環境で GURU でも起きている。本資料は GURU 側で同じ方針で直すための引継ぎである。GURU のソースは本リポジトリには含まれない。調査・修正は LexCrew-Doc リポジトリで行う。

## 症状（Word で想定される見え方）

- 文書 A を別ウィンドウで開いたまま、前面の文書 B（または Word のメイン的なウィンドウ）のリボンで GURU を押しても、**押した側に作業ウィンドウが出ない**。
- 作業ウィンドウは **裏で開いている別ウィンドウ** に付いている。ユーザーは「ボタンが効かない」と感じる。
- 別ウィンドウ側で GURU を押すと **再読込だけ** され、前面のウィンドウには出続けない場合がある。
- LexCrew-Mail では「メールのポップアップ（Inspector）が 1 つでも開いているだけ」で再現した。GURU でも **別 Word ウィンドウが 1 つ開いているだけ** で同型になりうる。

## LexCrew-Mail で確定した原因（v1.0.3 以前）

リボンの `onAction` ハンドラで、**押されたウィンドウ** より先に **COM の「アクティブ」ウィンドウ** を作業ウィンドウの親にしていた。

```csharp
// 旧コード（問題あり）
object parent = app.ActiveInspector() ?? app.ActiveExplorer();
if (parent == null) parent = ribbonControl.Context;
```

Outlook では、受信トレイ（Explorer）を前面にしていても `ActiveInspector()` が **開いたままのメールウィンドウ** を返すことがある（本 PC の Outlook 16.0.0.20430 で COM 測定済み）。その結果、Explorer リボンのボタンでも作業ウィンドウは Inspector に付く。

ログ `%TEMP%\kuru-addin.log` には `OnKuruClick` と `pane shown` だけ出て、ユーザー側には「何も起きない」ように見える。

## Word への当てはめ（調査で最初に見る箇所）

GURU で次のパターンを探す。名称はプロジェクトごとに違う。

| Outlook（Mail） | Word（Doc）で疑う API |
| --- | --- |
| `Application.ActiveInspector()` | `Application.ActiveWindow` |
| `Application.ActiveExplorer()` | 前面の `Document` / `Windows(1)` など |
| `IRibbonControl.Context` | 同じ（リボン XML の `onAction` 引数） |
| `ICTPFactory.CreateCTP(..., parentWindow)` | VSTO の `CustomTaskPanes.Add(..., window)` または同等の CTP 生成 |

**やってはいけないこと。** リボンクリック時に `ActiveWindow` や `ActiveDocument` を **Context より先** に親に使う。

**やること。** リボンから渡る `control.Context`（Word では `Window` または `Document` になることが多い）を親の第一候補にする。CreateCTP / CustomTaskPane に渡す HWND 所有者は **その Context が指すウィンドウ** に揃える。

Context の型は Word のリボン XML の載せ方で変わる。実機で 1 回ログに型名または `Class` を出して確認する（Mail では Explorer=34、Inspector=35）。

## 修正方針（Mail v1.0.3 と同じ仕様）

画面に出ている GURU / LexCrew の作業ウィンドウは **同時に 1 つ**。

1. **親ウィンドウ** … ボタンを押したリボンの `Context` のみ。アクティブウィンドウ API は使わない。
2. **表示** … 押したウィンドウのペインを `Visible = true`（または表示）し、**他のウィンドウに付いているペインは `Visible = false`**。破棄はしない。再度そのウィンドウで押せば同じペインを戻せる。
3. **古いペイン** … ウィンドウを閉じたあとも内部辞書に CTP が残ると、次回 COM 例外で黙る。**触ったときに例外なら辞書から外して作り直す**。
4. **キー** … ウィンドウを IUnknown アドレス等で識別している場合、閉じたあと同じキーが再利用され、死んだ CTP に `Visible = true` して失敗しうる。例外時は drop して Create し直す。
5. **ログ** … クリックごとに `parent=Window` / `parent=Document` など種別を 1 行。WebView2 初期化失敗もログに出す（Mail では以前 `async void OnLoad` が黙っていた）。

Mail では sidecar 起動直後の読み込み失敗に **最大約 30 秒 `Listening()` 待ちで再 Navigate** も入れた（`Sidecar.Listening()` 公開）。GURU も同型の「起動直後だけ真っ白／エラー」があれば同パターンを検討する。

## 参照実装（LexCrew-Mail）

- リポジトリ: `aquariumyossy/LexCrew-Mail`
- コミット: `ea8b1f7`（Release version 1.0.3）
- ファイル: [outlook/src/Connect.cs](../outlook/src/Connect.cs)

主要な流れ（名前は Mail 側）。

```
OnKuruClick(control)
  parent = ribbonControl.Context
  Log("OnKuruClick parent=" + ParentKind(parent))
  HideOtherPanes(key(parent))
  if TryShowPane(key) return
  CreateCTP(..., parent)
```

補助: `HideOtherPanes`, `TryShowPane`, `DropPane`, `KuruPane.Forget`, `ParentKind`（Outlook Class 34/35）。

## GURU 側の受け入れテスト（Mail の 4 場面の Word 版）

Outlook 起動直後の 4 項目は Mail v1.0.3 で **すべて OK**（2026-10-01、開発 PC）。Word でも同じ順で確認する。

1. **文書 A を別ウィンドウで開いたまま**、前面の文書 B（またはメインに相当するウィンドウ）のリボンで GURU を押す → **前面のウィンドウ** にペイン。ログに押した側の `parent=`。裏のウィンドウのペインは **隠れる**。
2. **裏で開いている文書 A のウィンドウ** で GURU を押す → **A** にペイン。前面 B のペインは隠れる。`parent=` は A 側。
3. **文書 A のウィンドウを閉じたあと**、前面で GURU を押す → 例外で止まらず前面に出る。
4. **Word 起動直後** に前面で GURU を押す → 前面に出る（sidecar 待ちで再読み込みする場合あり）。

## ログ・切り分け

| ログの並び | 意味 |
| --- | --- |
| `OnKuruClick` → `pane shown` / `pane reloaded`、例外なし | コードは動いている。親取り違えなら **別ウィンドウ** を探す（Mail ではタスクバーのメールウィンドウ）。 |
| 上記のあと `parent=Explorer` 等が **出ない** | まだ旧 DLL / 旧ビルドの可能性。 |
| 例外（COM、`CreateCTP` 等） | 文字列が原因。閉じたウィンドウの CTP 残骸を疑う。 |
| `OnKuruClick` 自体が無い | アドイン無効（Outlook では `LoadBehavior=2`）、リボン未読込。 |

Mail のログ: `%TEMP%\kuru-addin.log`。GURU 側のパスは Doc プロジェクトの慣例に合わせる。

## LexCrew 製品間の共有（参考）

- **接続設定** … `%APPDATA%\LexCrew\connection.json`。Mail の sidecar は Doc が書いたファイルを起動時に上書きしない（[src/sidecar/connection.ts](../src/sidecar/connection.ts) コメント参照）。
- **履歴 DB** … Mail は `%APPDATA%\KURU\history.db`。Doc は別パスの想定。
- 本引継ぎの修正は **Word ホスト側の CTP 親ウィンドウ** の話であり、connection.json の形式変更は不要。

## リリース

Mail は GitHub Release **v1.0.3**（`LexCrew-Mail-Setup-1.0.3.exe`）。Doc 側も同型修正後、バージョンとリリース文面は従来の Doc リリース形式に合わせる。

---

**引継ぎ先での最初の 1 手:** リボン `onAction` 内で `ActiveWindow` / `ActiveDocument` を親に使っている行を grep し、`IRibbonControl.Context`（または VSTO の `control.Context`）だけに差し替える可否を確認する。
