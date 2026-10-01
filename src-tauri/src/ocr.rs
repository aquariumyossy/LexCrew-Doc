//! What the sidecar needs to read a page image. Twin of `src/shared/ocr.ts`.

/// One page at a time, so a long scan does not depend on one huge reply.
pub const OCR_PROMPT: &str = concat!(
    "この画像は日本の法律文書を紙で読み取ったものです。書かれている文字をそのまま書き出してください。\n",
    "要約・翻訳・言い換えをしません。読めない文字は「□」にします。\n",
    "段落と改行は元の見た目に合わせます。罫線だけの表は行ごとにタブ区切りで書きます。表は図にしません。\n",
    "箱や文字が線や矢印で結ばれているときは、本文のあとに「〔図〕」と1行置き、結ばれている相手を1行ずつ書きます。箱の中の文字は日付も含めて残します。端点は箱の文字を短くせずそのまま書きます。\n",
    "向きのある矢印は「山田太郎 → 山田花子」です。線のそばに文字があるときは「山田太郎 -子→ 山田花子」とします。矢印が無く一重の線は「山田太郎 — 山田花子」、二重の線は「山田太郎 ═ 山田花子」、点線は「山田太郎 ┄ 山田花子」です。並びは図の位置のまま（上または左を先）にします。\n",
    "親子、婚姻、養子とは書きません。上下の配置から矢印に変えません。二重線を婚姻とは呼びません。図が無いページでは「〔図〕」を書きません。紙に印刷された「図1」などの見出しは本文の文字として残します。\n",
    "文字が何も無ければ、何も書かずに空で返してください。感想や説明は書きません。"
);

/// A page of dense text is around 2,000 characters; this is room to spare.
pub const MAX_OCR_PAGE_CHARS: usize = 40_000;

const VISION_HINTS: &[&str] = &[
    "image",
    "vision",
    "multimodal",
    "image_url",
    "content must be a string",
];

/// A text-only model refuses the request rather than answering badly, and the
/// refusal is worth translating: the user has to pick another model, and the
/// upstream wording does not say so.
pub fn vision_unsupported_message(detail: &str) -> Option<&'static str> {
    let lowered = detail.to_lowercase();
    if VISION_HINTS.iter().any(|hint| lowered.contains(hint)) {
        Some("このモデルは画像を読めません。設定で画像に対応したモデルを選んでください。")
    } else {
        None
    }
}

/// Cuts the reply to `MAX_OCR_PAGE_CHARS` without splitting a character.
pub fn clip_page(text: &str) -> String {
    if text.chars().count() <= MAX_OCR_PAGE_CHARS {
        return text.to_string();
    }
    text.chars().take(MAX_OCR_PAGE_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_model_as_the_problem_when_it_cannot_see() {
        assert!(vision_unsupported_message("this model does not support image input").is_some());
        assert!(vision_unsupported_message("Vision is not enabled").is_some());
        assert!(vision_unsupported_message("context length exceeded").is_none());
    }

    #[test]
    fn clips_a_long_page_on_a_character_boundary() {
        let long: String = "あ".repeat(MAX_OCR_PAGE_CHARS + 10);
        assert_eq!(clip_page(&long).chars().count(), MAX_OCR_PAGE_CHARS);
        assert_eq!(clip_page("第1条"), "第1条");
    }
}
