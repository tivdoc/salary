const layers = [
  { number: "01", title: "תלוש שכר", text: "מה שולם ומה נוכה במסמך." },
  { number: "02", title: "חוזה עבודה", text: "מה סוכם לגבי השכר, התפקיד והתנאים." },
  { number: "03", title: "שעות העבודה בפועל", text: "כמה עבדת, באילו ימים ומה קרה בהפסקות." },
  { number: "04", title: "התפקיד בפועל", text: "מה באמת עשית, גם אם הכותרת בחוזה אומרת אחרת." },
  { number: "05", title: "הזכויות וכללי השכר", text: "הכללים הרלוונטיים מול כל שכבות המידע שסופקו." },
];

export function DocumentLayers() {
  return (
    <section className="layers-section" aria-labelledby="layers-title">
      <div className="shell layers-section__intro">
        <p className="eyebrow">יותר מבדיקת PDF</p>
        <h2 id="layers-title">תלוש הוא רק השכבה הראשונה.</h2>
        <div className="layers-section__difference">
          <span>בדיקת תלוש נעצרת כאן.</span>
          <strong>Tivdoc ממשיך מכאן.</strong>
        </div>
      </div>
      <div className="shell layer-stack">
        {layers.map((layer, index) => (
          <article className="document-layer" style={{ "--layer-index": index } as React.CSSProperties} key={layer.title}>
            <span className="document-layer__number mono">{layer.number}</span>
            <div>
              <h3>{layer.title}</h3>
              <p>{layer.text}</p>
            </div>
            <div className="document-layer__trace" aria-hidden="true">
              <i /><i /><i />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
