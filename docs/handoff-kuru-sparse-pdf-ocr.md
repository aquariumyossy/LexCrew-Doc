# KURU で少量テキストの PDF を OCR する

GURI は、各ページの文字層が空白と改行を除いて 200 字以下の PDF を、文字の抜き出しではなく既存の OCR に送る。KURU はまだ、1 字でも文字があれば文字層を本文にする。作業は `C:\KURU` で行う。コンポーザーへの添付とメール添付は、同じ読み取りを通る。ゲートを 1 箇所変えれば両方とも変わる。

## 判定

利用者が PDF を付けると、KURU は `readPdfPages` でページごとの文字列を取る。すべてのページが 200 字以下なら、その PDF 全体を今のスキャンと同じ OCR に乗せる。1 ページでも 201 字以上なら、今どおり文字層を本文にする。

字数は `page.replace(/\s/g, "").length` である。空白、改行、タブ、全角空白は数えない。空のページ配列も OCR 側である。`Array.every` は空配列で真を返す。

OCR の描画、プロンプト、20 ページ上限は変えない。

## 定数と述語を置き換える

`src/shared/constants.ts` の `MAX_OCR_PAGES` の直後に、次の定数を置く。

```ts
export const PDF_SPARSE_PAGE_CHARS = 200;
```

`src/shared/attachedFiles.ts` は、先頭の `constants` の import に `PDF_SPARSE_PAGE_CHARS` を足す。同じファイルの `pdfHasTextLayer` を、次の関数に置き換える。古い関数は残さない。1 字でも真、という意味の名前が残ると、次の読み手が判定を戻す。

```ts
function pdfPageGlyphs(page: string): number {
  return page.replace(/\s/g, "").length;
}

export function pdfNeedsOcr(pages: string[]): boolean {
  return pages.every((page) => pdfPageGlyphs(page) <= PDF_SPARSE_PAGE_CHARS);
}
```

関数の上のコメントも置き換える。今のコメントは、1 字あれば文字層を信用すると書いてある。残すと実装と逆になる。GURI の `pdfNeedsOcr` のコメントを写してよい。

## 呼び出しを 1 箇所変える

`src/taskpane/files/read.ts` の `readPdf` は、`pdfHasTextLayer` が偽のときスキャンにしている。import と条件を次に変える。渡すページ数は `handle.doc.numPages` のままにする。

```ts
if (pdfNeedsOcr(pages)) {
  return { status: "scan", pages: handle.doc.numPages };
}
```

`src/taskpane/files/attach.ts` は触らない。`ingestBytes` は `readBytes` が `scan` を返したとき、すでに OCR を始める。メール添付の `loadMail` も同じ `ingestBytes` を使う。

## テストを期待値ごと変える

`src/shared/attachedFiles.test.ts` は、1 字あれば文字層だと期待している。その期待をやめ、`pdfNeedsOcr` を次のとおりにする。

- `["", " あ"]`、空白だけのページ、空配列、200 字のページは真。
- `"あ"` を 50 字、空白と改行と全角空白、`"い"` を 150 字、を 1 ページに連結しても真。
- 201 字のページが 1 枚でもあれば偽。

確認は次のコマンドで行う。

```
npx vitest run src/shared/attachedFiles.test.ts
```

## コピーしないもの

GURI の `src/taskpane/chat/execute.ts` と `src/shared/tools.ts` は、Argos の全文読み向けに文言を変えている。KURU にその文言は無い。コピーしない。

`MAX_OCR_PAGES` は 20 のままにする。21 ページ目以降は今のスキャンと同じく読まない。

1 ページでも 201 字以上ある PDF は、残りのページが画像でも文字層だけになる。ページごとに文字と OCR を混ぜない。

OCR に進んだら短い文字層は残さない。`ocrBytes` の結果だけを本文にする。

接続設定が無い短い PDF は、今のスキャンと同じく「画像を読むには接続の設定が必要です」で失敗する。リモートの LLM では、既存の `REMOTE_OCR_NOTICE` が一度出る。告知は足さない。

`readPdfPages` は `MAX_FILE_CHARS` の 6 万字でページ文字列を切る。判定用の別読みは足さない。切り詰めのせいで長いページが 200 字以下に見えるのは、手前だけで約 6 万字あるときだけである。

ページに画像があるかでは分けない。

`README.md` の「画像やスキャン PDF は、設定した LLM の画像読み取りを使う」は、この PDF をスキャンと同じ経路に乗せたあともそのままでよい。

## GURI で比べる箇所

GURI では述語が `src/shared/extract/plain.ts` にある。KURU では `src/shared/attachedFiles.ts` にある。ファイルは移動しない。

- `C:\GURI\src\shared\constants.ts` の `PDF_SPARSE_PAGE_CHARS`
- `C:\GURI\src\shared\extract\plain.ts` の `pdfNeedsOcr`
- `C:\GURI\src\taskpane\files\read.ts` の `readPdf`
- `C:\GURI\src\shared\extract\plain.test.ts`
