"use client";

import {useEffect, useRef, useState} from 'react';

/** Manual playback only. Returning to the page never resumes it implicitly. */
export function ExplainerVideo({poster="/media/tivdoc-explainer-poster.png"}:{poster?:string}) {
 const video = useRef<HTMLVideoElement>(null);
 const [failed, setFailed] = useState(false);
 useEffect(() => {
  const media = video.current;
  if (!media) return;
  const pauseWhenHidden = () => { if (document.hidden) media.pause(); };
  const observer = new IntersectionObserver(entries => {
   if (entries.some(entry => !entry.isIntersecting)) media.pause();
  });
  observer.observe(media);
  document.addEventListener('visibilitychange', pauseWhenHidden);
  return () => { observer.disconnect(); document.removeEventListener('visibilitychange', pauseWhenHidden); };
 }, []);
 return <>
  <video ref={video} className="explainer-video" controls playsInline preload="none"
   poster={poster} onError={() => setFailed(true)}
   aria-label="סרטון הסבר על התהליך המתוכנן, 30 שניות ללא קול">
   <source src="/media/tivdoc-explainer.mp4" type="video/mp4" onError={() => setFailed(true)} />
   <track kind="captions" src="/media/tivdoc-explainer.he.vtt" srcLang="he" label="עברית" />
   הדפדפן אינו תומך בווידאו. ההסבר הכתוב מופיע בהמשך.
  </video>
  {failed ? <p className="explainer-video-error" role="status">הסרטון לא נטען. <a href="#explainer-transcript" onClick={() => {
   const transcript = document.getElementById('explainer-transcript');
   if (transcript instanceof HTMLDetailsElement) transcript.open = true;
  }}>אפשר לקרוא את ההסבר המלא כאן.</a></p> : null}
 </>;
}
