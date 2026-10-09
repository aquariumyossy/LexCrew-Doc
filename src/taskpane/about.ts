export const DISCLAIMER =
  "できた文面は下書き・点検用であり、法律意見ではありません。判例・条文番号は未確認として扱ってください。Word に出典として入るのは、ウェブ検索で当たったページの題名と URL、Argos で当たった資料の題名とファイルの場所だけです。";

export type LibraryNotice = {
  name: string;
  license: string;
  copyright: string;
  choice?: string;
};

export type AboutFeature = {
  title: string;
  body: string;
};

export const aboutCopy = {
  title: "LexCrew Doc について",
  buttonLabel: "このアプリについて",
  hint: "できることの説明を開きます",
  overview: [
    "Word の文書画面で、点検や起案、文面の直しができます。やりたいことを書くと、開いている文書を読みます。",
    DISCLAIMER,
  ],
  features: [
    {
      title: "指示して文書を直す",
      body: "入力欄に「この条項を点検してコメントして」「この条を書き換えて」「請求の趣旨を起案して」と書くと、開いている文書の文面を作ります。文字や段落の書式も変えられます。文書への変更は、通常は変更履歴に残ります。行グリッド、段落前後、インデント、見本の行間を段落の OOXML で直すあいだだけ、履歴を切ります。チャットに出た文章は文書には入りません。表、罫線、ページ余白は変えられません。",
    },
    {
      title: "コメントと変更履歴",
      body: "コメントを付けられます。相手のコメントと変更履歴も読めます。コメントへの返信、変更の受入れ・却下はできません。",
    },
    {
      title: "参考にする情報",
      body: "ウェブ検索と、入力欄の argos で選んだフォルダの資料を参考にできます。",
    },
    {
      title: "ファイル",
      body: "クリップかドラッグ＆ドロップで付けたファイルの中身を読んで、文面に活かせます。",
    },
    {
      title: "履歴",
      body: "「会話の履歴」から、前のやり取りに戻れます。文書を開き直すと、その文書でいちばん最近更新した会話が開きます。",
    },
  ] satisfies AboutFeature[],
  licenseNote: "実行時に読み込むライブラリです。",
  licenses: [
    {
      name: "JSZip",
      license: "MIT",
      copyright: "Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso",
      choice: "MIT または GPL-3.0。本アプリは MIT。",
    },
    { name: "pdf.js", license: "Apache-2.0", copyright: "Copyright 2024 Mozilla Foundation" },
    { name: "react-markdown", license: "MIT", copyright: "Copyright (c) Espen Hovlandsdal" },
    { name: "rusqlite", license: "MIT", copyright: "Copyright (c) 2014 The rusqlite developers" },
  ] satisfies LibraryNotice[],
  credit: "弁護士　吉田秀平",
};
