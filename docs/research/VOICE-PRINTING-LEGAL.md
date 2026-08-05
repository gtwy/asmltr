# Voice Printing (Voice Biometrics) for a Personal AI Meeting Recorder — Legal & Practical Deep-Dive

**Status:** Research / design input — **NOT legal advice.** Written for a build decision on the asmltr meeting-recorder feature. Verify with a licensed attorney before relying on any of this in production, especially before enabling third-party voiceprinting in a commercial product. Law here is fast-moving and varies sharply by state.

**Date:** 2026-08-05
**Owner question:** *"Do you need explicit SEPARATE consent for voice printing beyond consent to record? Where are the lines, and what would make for a reasonable, actually-buildable tool?"*

**Short answer up front:** **Yes.** In the jurisdictions that matter most (Illinois above all, plus the EU/UK and a growing set of US states), a *voiceprint* is a legally distinct thing from a *recording*, and consent-to-record does **not** cover it. The feature you described — build a persistent voiceprint to recognize a recurring speaker across recordings — is exactly the conduct currently being sued over (Otter.ai, Fireflies). It is buildable and defensible, but only with a **separate, plain-language, opt-in biometric consent**, a **published retention/destruction policy**, encrypted per-person storage, no sale/sharing, and jurisdiction-aware gating. See §6 for the concrete design.

---

## 1. Is a voiceprint legally distinct from a recording?

**Yes, in most relevant jurisdictions.** A recording is *audio content*. A **voiceprint** is a *biometric identifier* — data produced by technical processing of a person's unique vocal characteristics for the purpose of identifying that specific individual. Two different legal regimes attach to them, with two different consent standards:

- **Recording** → governed by **wiretap / eavesdropping statutes** (federal ECPA + state one-party/all-party consent laws). Consent is often satisfiable by a spoken announcement.
- **Voiceprint** → governed by **biometric privacy statutes** (Illinois BIPA, Texas CUBI, Washington HB 1493) and **comprehensive privacy laws' "sensitive data" rules** (CCPA/CPRA, Colorado, etc.), and in the EU/UK by **GDPR Art. 9 special-category data**. Consent here is a *higher bar* — typically written/explicit, with notice, retention limits, and no-sale rules.

The critical modern point: **speaker diarization is the trigger.** Plain transcription (audio → text) is generally *not* biometric processing. But the moment your system analyzes vocal-tract characteristics to say "this is Speaker 1" and — especially — to **link that voice to a person record and recognize them in future recordings**, courts and plaintiffs treat that as *generating and storing a voiceprint*. As one practitioner guide puts it: *"Speaker ID (Diarization) is the exact moment the software creates a biometric identifier."* ([UMEVO / BIPA & AI voice recorders](https://www.umevo.ai/blogs/ume-all-posts/how-biometric-privacy-laws-like-illinois-bipa-apply-to-ai-voice-recorders); [Basil AI, 2026](https://basilai.app/articles/2026-05-02-ai-meeting-bots-voiceprint-harvesting-bipa-lawsuits-biometric-privacy.html))

> **Design consequence:** *Cross-recording speaker recognition is the exact feature that crosses the line.* One-shot, disposable "Speaker 1/2" labels that are discarded after the session are far lower-risk than a persistent voiceprint linked to a durable person record. That distinction should drive the build.

---

## 2. US biometric privacy statutes

### 2.1 Illinois BIPA — 740 ILCS 14 (the one that actually bites)

BIPA is the highest-risk statute in the US because it has a **private right of action** and does **not require proof of actual harm** beyond the statutory violation (*Rosenbach v. Six Flags*, 2019). Plaintiffs' firms have built an industry around it.

**Voiceprints are explicitly enumerated.** BIPA's "biometric identifiers" = *retina/iris scan, fingerprint, **voiceprint**, or scan of hand or face geometry.* ([Recording Law – BIPA](https://www.recordinglaw.com/us-laws/data-privacy-laws/bipa/); [740 ILCS 14 on Justia](https://law.justia.com/codes/illinois/chapter-740/act-740-ilcs-14/))

**Section 15 requirements (all apply to collecting a voiceprint):**

| § | Requirement |
|---|---|
| **15(a)** | **Publish and follow a written retention & destruction schedule.** Destroy biometric data when the purpose is satisfied **or within 3 years of the person's last interaction, whichever is first.** |
| **15(b)** | **Before collection**, provide **written notice** of (i) *what* is collected, (ii) the *specific purpose*, and (iii) the *length of term* of collection/storage/use — **and obtain a written release.** A 2024 amendment (SB 2979) confirms an **electronic signature** counts as the written release. |
| **15(c)** | **No sale, lease, trade, or profit** from biometric data. Full stop. |
| **15(d)** | **No disclosure** without consent, except narrow exceptions (completing a transaction the person requested; valid warrant/subpoena). |
| **15(e)** | **Store securely** using at least the reasonable standard of care for the industry, and the same or more protective manner as other confidential data. |

([Recording Law – BIPA](https://www.recordinglaw.com/us-laws/data-privacy-laws/bipa/); [King & Spalding – BIPA reform](https://www.kslaw.com/news-and-insights/illinois-bipa-reform-takes-effect); [Greenberg Traurig – 2024 amendment](https://www.gtlaw.com/en/insights/2024/8/bipa-update-illinois-limits-liability-and-clarifies-electronic-consent-for-biometric-data-collection))

**Statutory damages (§20):** **$1,000 per negligent violation; $5,000 per intentional/reckless violation**, plus attorneys' fees and injunctive relief. The **2024 amendment (SB 2979)** limited liability by clarifying that repeated collection of the *same* identifier from the *same* person by the *same* method is a **single** violation (curbing the old per-scan multiplication), and the Seventh Circuit held that limit applies retroactively. ([WilmerHale 2024 review](https://www.wilmerhale.com/en/insights/blogs/wilmerhale-privacy-and-cybersecurity-law/20250219-year-in-review-2024-bipa-litigation-takeaways); [Davis Wright Tremaine](https://www.dwt.com/blogs/privacy--security-law-blog/2024/08/illinois-bipa-biometrics-law-amended-for-damages)) Even post-amendment, exposure across a user base is large.

**This is not hypothetical for meeting recorders.** In 2025 four class actions (*Brewer, Walker, Theus, Winston*) were filed against **Otter.ai** and consolidated as **In re Otter.AI Privacy Litigation (5:25-cv-06911)**, N.D. Cal., before Judge Eumi K. Lee — alleging Otter extracts and stores participants' voiceprints via diarization *without written consent* and uses them to identify speakers in later meetings. A May 2026 motion-to-dismiss hearing was the first federal test of whether AI bots are "third-party eavesdroppers." Similar suits target **Fireflies.ai**. ([Bloomberg Law](https://news.bloomberglaw.com/artificial-intelligence/otter-ai-hit-with-bipa-class-suit-over-voice-print-collection); [National Law Review](https://natlawreview.com/article/take-note-new-wave-privacy-litigation-targets-ai-notetaker-otterai); [Basil AI – Otter litigation](https://basilai.app/articles/2026-06-21-in-re-otter-ai-privacy-litigation-may-2026-hearing-explained.html)) **The feature you're describing is the thing being litigated.**

### 2.2 Texas CUBI — Capture or Use of Biometric Identifiers Act

- Covers **voiceprints** among biometric identifiers.
- **Notice + consent required before capture** for a commercial purpose; restricted disclosure; reasonable-care storage; **destroy within a reasonable time, no later than 1 year** after the purpose expires.
- **No private right of action** — enforced only by the **Texas Attorney General**, civil penalties up to **$25,000 per violation.** But the AG is aggressive: a **$1.4 billion** settlement with Meta over face-geometry "Tag Suggestions" (July 2024), and CUBI theories have been asserted against **Google Photos (face geometry), Google Assistant (voiceprints), and Nest** for capturing biometrics without consent.

([Recording Law – Texas](https://www.recordinglaw.com/us-laws/data-privacy-laws/texas-data-privacy-laws/biometric-privacy/); [ITECS CUBI guide 2026](https://itecsonline.com/post/texas-biometric-identifier-act-cubi-a-compliance-guide-for-businesses-capturing-fingerprints-faces-or-voices); [SIA – Texas 2024/2025](https://www.securityindustry.org/2025/06/24/groundbreaking-texas-ai-law-also-brings-needed-clarity-on-use-of-biometric-technologies-for-security/))

### 2.3 Washington HB 1493 (RCW 19.375)

- Prohibits **enrolling a biometric identifier (incl. voiceprint) in a database for a commercial purpose** without first **giving notice, obtaining consent, OR providing a mechanism to prevent** subsequent commercial use.
- Explicitly treats **notice and consent as separate things**, with the exact form being **"context-dependent."**
- Bars using/disclosing the identifier in a way **materially inconsistent** with the original terms without fresh consent.
- **No private right of action** — AG enforcement only.

([Hunton](https://www.hunton.com/privacy-and-cybersecurity-law-blog/washington-becomes-third-state-enact-biometric-privacy-law); [TermsFeed HB 1493](https://www.termsfeed.com/blog/washington-biometric-privacy-law-hb-1493/); [Inside Privacy](https://www.insideprivacy.com/united-states/state-legislatures/washington-becomes-the-third-state-with-a-biometric-law/))

### 2.4 Comprehensive privacy laws (2024–2026) — the broader "sensitive data" layer

As of early–mid 2026, **~20 US states** have comprehensive consumer privacy laws, and **nearly all classify biometric data as "sensitive data"** requiring heightened treatment. ([Recording Law – state comparison](https://www.recordinglaw.com/us-laws/data-privacy-laws/us-state-privacy-laws-comparison/); [Consenteo 2026 tracker](https://www.consenteo.com/knowledge-hub/legal/us_state_privacy_law_tracker_2026); [Privacy World 2025 roundup](https://www.privacyworld.blog/2025/12/2025-state-privacy-roundup-key-trends-and-california-developments-to-watch-in-2026/))

- **California (CCPA/CPRA):** A "voiceprint" is **sensitive personal information (SPI).** California uses a *different mechanism* than opt-in — a consumer's **right to "Limit the Use of Sensitive Personal Information"** — plus notice-at-collection, purpose limitation, and no-sale/no-share rights. (SB 1223, eff. Jan 1 2025, even added *neural data* to SPI, showing the trend toward more biometric-style protection.) ([Recording Law – California](https://www.recordinglaw.com/us-laws/data-privacy-laws/california-data-privacy-laws/biometric-privacy/))
- **Colorado, Virginia, Connecticut, Oregon, Montana, and most other comprehensive-law states:** biometric data is sensitive → generally require **opt-in consent before processing**, plus access/deletion rights. Colorado **amended its Privacy Act in 2024** to add specific biometric provisions.

**Net:** Even outside Illinois/Texas/Washington, a voiceprint is "sensitive data" almost everywhere with a modern privacy law → opt-in consent (or CA's limit-use right), purpose limitation, deletion rights, and no-sale are the default expectations.

---

## 3. Wiretap / recording-consent law — and why it is NOT enough

Recording is governed separately:

- **Federal ECPA** + **one-party consent** states: one participant (you) consenting is enough to record.
- **All-party / "two-party" consent** states (CA, IL, FL, PA, WA, MA, MD, MI, MT, NH, CT, and others) require **every** participant to consent to the *recording*. For these, a clear **audible announcement** at the top ("this call is being recorded") that everyone stays on for is usually treated as consent to record. ([KTS Law – wiretap map](https://ktslaw.com/en/Insights/Alert/2024/7/Wiretap-Laws-in-the-United-States); [Reed Smith – AI recording/transcription](https://www.employmentlawwatch.com/post/102ls2n/the-legality-of-ai-powered-recording-and-transcription))

**The key interaction:** *Recording consent ≠ biometric consent.* They are two distinct legal obligations. A spoken "this is being recorded" disclaimer that satisfies a wiretap statute **does not** satisfy BIPA's §15(b), which requires **written notice and a written release before the voiceprint is extracted.** ([UMEVO](https://www.umevo.ai/blogs/ume-all-posts/how-biometric-privacy-laws-like-illinois-bipa-apply-to-ai-voice-recorders); [Basil AI – two-party guide](https://basilai.app/articles/2026-07-07-recording-meetings-two-party-consent-states-ai-notetaker-compliance-guide-2026.html)) Presence in a recorded meeting — even a visible bot in the participant list — is **not** consent to biometric processing.

So the app can have **three** distinct consent conditions layered on one recording:
1. Wiretap consent to **record** (announcement / all-party).
2. Biometric consent to **create/store a voiceprint** (written, separate).
3. Sensitive-data handling under comprehensive laws (notice, no-sale, deletion).

---

## 4. GDPR / EU (and UK GDPR)

Under **GDPR Art. 4(14)**, a **voiceprint produced by "specific technical processing" to uniquely identify a person is biometric data**, and when used *for identification* it is **special-category data under Art. 9**. Processing special-category data is **prohibited** unless an Art. 9(2) condition applies — and for a consumer app the realistic one is **Art. 9(2)(a): explicit consent.** ([Art. 9 GDPR](https://gdpr-info.eu/art-9-gdpr/); [Secure Privacy – Art. 9 guide 2026](https://secureprivacy.ai/blog/gdpr-article-9-special-categories-lawful-processing-and-compliance-guide-2026))

Practical EU/UK requirements for the voiceprint feature:
- **Two-layer lawful basis:** an **Art. 6** basis *and* an **Art. 9(2)** condition (explicit consent).
- **Explicit consent** is a *higher bar* than ordinary consent: specific, informed, unambiguous, affirmative, and **freely given** (note: it is often invalid in employer/employee contexts because it isn't "free" — relevant if this app is ever used at work).
- A **Data Protection Impact Assessment (DPIA)** is effectively **mandatory** for biometric identification.
- Plus the usual GDPR rights: access, erasure ("right to be forgotten"), data minimization, storage limitation, purpose limitation.
- The **ICO (UK)** has already found that voiceprints are Art. 9 special-category data and that the *only* available basis (explicit consent) had not been obtained in an enforcement matter.

([GDPRLocal – biometric compliance](https://gdprlocal.com/biometric-data-gdpr-compliance-made-simple/); [DILR.ai – voice biometric GDPR](https://www.dilr.ai/blog/ai-voice-biometric-data-security-enterprise))

---

## 5. The owner's analogy: "Google Photos face-scans photos I took without the subject's separate consent — how is voiceprinting different?"

Honest answer: **the analogy partly holds — and where it breaks, it breaks *against* voiceprinting, not for it.**

**Where it holds:** Google Photos' Face Grouping *did* extract face-geometry biometrics from photos of people who never separately consented — and Google **got sued and paid for it.** *Rivera v. Google* settled for **$100M** in Illinois over exactly this BIPA theory, and Texas asserted CUBI against Google Photos too. So the intuition "this is a real legal exposure" is *correct*; it's just that Google's behavior is the **cautionary tale, not the safe precedent.** Meta paid **$650M** (Illinois) and **$1.4B** (Texas) for the analogous face-tagging. ([Top Class Actions – Rivera/Google $100M](https://topclassactions.com/lawsuit-settlements/closed-settlements/google-photos-face-recognition-privacy-100m-class-action-settlement/); [Recording Law – Texas/Meta $1.4B](https://www.recordinglaw.com/us-laws/data-privacy-laws/texas-data-privacy-laws/biometric-privacy/))

**Where it breaks — and why voice is *worse*, not better:**

1. **BIPA has a "photographs" carve-out; it has NO audio/voice carve-out.** BIPA's definition **excludes photographs and information derived from photographs** (and writing samples, demographics, physical descriptions). That carve-out is precisely what let Google *litigate* the face-from-photos question (defendants argued face templates came from exempt "photographs"). **There is no equivalent exemption for voice.** A **voiceprint is expressly enumerated** as a covered identifier with no escape hatch. So voiceprinting is a **cleaner, more clearly-covered** BIPA violation than face-scanning-from-photos ever was. ([MoFo – "identifiers must identify"](https://www.mofo.com/resources/insights/240503-getting-bipa-right-biometric-identifiers-must-identify); [Recording Law – BIPA](https://www.recordinglaw.com/us-laws/data-privacy-laws/bipa/))
2. **"I took the photo" ≠ "I own the biometric."** Owning/creating the medium (photo or recording) does not grant rights to extract and store a third party's *biometric identifier*. The biometric belongs, legally, to the *subject*, whose separate consent BIPA/CUBI/GDPR require.
3. **Personal-use ambiguity.** Some of these statutes are aimed at commercial/"private entity" processing. A purely personal, on-device, never-shared voiceprint of *yourself* is low-risk. Voiceprinting *other people* and building a durable identity database — even "just for me" — starts to look like the enrolling-a-database conduct the statutes target, and BIPA's private right of action doesn't require you to be a giant company.

**Bottom line on the analogy:** "Google did it" is true but is an argument *for caution* — Google paid nine figures. And voice is on **weaker** legal footing than the photo case because the photo exemption that gave Google an argument **does not exist for voice.**

---

## 6. Practical design — a defensible, actually-buildable feature

The goal: keep the genuinely useful "recognize recurring speakers" capability while staying on the right side of the line. The design principle is **owner-first, opt-in-for-others, local-and-deletable, never-sold.**

### Do

- **Voiceprint the OWNER by default; require explicit opt-in for everyone else.** The owner consenting to their *own* voiceprint is clean. Third-party voiceprints are the risk — gate them behind an explicit toggle.
- **Separate the two consents in the UI.** Keep "record this meeting" and "build a voiceprint to recognize you next time" as **distinct** acknowledgements. Never bundle biometric consent into the recording consent or a blanket ToS click.
- **Surface a plain-language, record-time opt-in** for third parties, e.g.:
  > *"I can also turn on voice recognition so this app remembers your voice and labels you in future recordings. That means storing a voiceprint (biometric data). Want me to? [Yes] [No, just this recording]."*
  Capture the answer as a **written/recorded release** and store proof (who, when, scope). BIPA's 2024 amendment confirms **electronic signature** suffices.
- **State purpose + retention at consent time** (BIPA §15(b) requires purpose *and duration*). e.g. "Used only to recognize you in your recordings; deleted after 12 months of no new recordings, or on request."
- **Publish a retention & destruction policy and auto-enforce it.** Default a conservative retention (e.g. destroy on request and after N months of inactivity — well inside BIPA's 3-yr and CUBI's 1-yr backstops). Make deletion actually delete the voiceprint template, not just hide it.
- **Store voiceprints encrypted, per-person, locally / on-device where possible.** Local-first processing (e.g. on-device diarization / local models) dramatically shrinks exposure vs. cloud extraction — it's the design Otter is being punished for *not* using. Encrypt at rest; treat the template as your most sensitive data class (BIPA §15(e)).
- **Give one-tap per-person deletion + "delete all voiceprints"**, and honor it as a GDPR/CCPA erasure right.
- **Jurisdiction-aware gating.** Let the owner set locale; in **Illinois/EU/UK** default third-party voiceprinting **OFF** and require the explicit written flow before it can be enabled. Consider disabling automatic third-party enrollment entirely in the strictest jurisdictions.
- **Keep raw recording consent separate and layered** on top of wiretap needs (all-party announcement in two-party states).
- **Separate the disposable label from the durable identity.** Ephemeral "Speaker 1/2" diarization for a single transcript (discarded after) is far lower risk than a persistent cross-recording voiceprint. Make persistence the *opt-in* upgrade.
- **Run a DPIA** if the EU/UK is in scope, and log it.

### Don't

- **Don't** treat "they were in the meeting / a bot was visible" as consent to voiceprint. It isn't.
- **Don't** rely on a spoken "this is being recorded" line to authorize biometric extraction — wiretap consent ≠ biometric consent.
- **Don't** auto-enroll third parties' voiceprints silently in the background. That is the Otter/Fireflies fact pattern.
- **Don't** ever **sell, share, license, or use voiceprints to train models** — BIPA §15(c) flatly bars profiting from them; comprehensive laws bar sale of sensitive data. Kill any "improve our models with your audio" default.
- **Don't** bundle biometric consent inside the general Terms of Service or a single "I agree."
- **Don't** retain voiceprints indefinitely or with no published schedule (BIPA §15(a) / CUBI 1-yr / GDPR storage limitation).
- **Don't** disclose voiceprints to third parties/subprocessors without separate consent (BIPA §15(d)).
- **Don't** assume "personal / just for me" exempts you when you're printing *other people's* voices — the private right of action reaches individuals and small operators.

### A concrete, defensible default configuration

1. **Owner voiceprint:** ON by default (self-consent), stored encrypted locally.
2. **Third-party voiceprint:** OFF by default. Enabling it, per person, requires the record-time explicit opt-in flow + stored proof + stated purpose/retention.
3. **Ephemeral diarization** (Speaker 1/2 for the current transcript only, discarded): allowed without voiceprint persistence.
4. **Storage:** encrypted, per-person templates, local-first; no cloud unless the user opts in.
5. **Retention:** auto-delete on request and after inactivity; published schedule; hard backstops < CUBI 1yr / BIPA 3yr.
6. **No sale, no sharing, no model-training** on voiceprints — hard-coded, not a toggle.
7. **Jurisdiction gate:** IL / EU / UK → third-party voiceprinting locked behind explicit written consent (or off).

This configuration maps cleanly onto §15(a)–(e) of BIPA, CUBI's notice/consent/destruction, Washington's separate notice+consent, the comprehensive laws' sensitive-data/opt-in/no-sale/deletion expectations, and GDPR Art. 9 explicit consent + DPIA + erasure.

---

## 7. Bottom line the owner can act on

- **Consent-to-record does NOT cover voiceprinting.** They are legally distinct, with distinct (and higher) consent standards. Build them as separate steps.
- **The persistent, cross-recording speaker-recognition feature is the exact conduct being sued over right now** (Otter.ai, Fireflies) under Illinois BIPA — a statute with a **private right of action, no-harm-required, and $1k–$5k/violation** damages. This is the single biggest risk vector.
- **Voiceprinting yourself is fine. Voiceprinting other people needs an explicit, separate, plain-language opt-in**, a stated purpose + retention, encrypted per-person storage, easy deletion, no sale/sharing/training, and jurisdiction-aware gating (default OFF in IL/EU/UK).
- **The "Google Photos does it" analogy cuts the wrong way:** Google *lost* and paid $100M (and Meta far more), and voice is on **weaker** footing than photos because BIPA's photo carve-out has **no voice equivalent.**
- **A reasonable, buildable tool** = owner-first + explicit opt-in for others + local/encrypted + deletable + never-sold + published retention + locale gating. That's defensible, genuinely useful, and materially different from the products getting sued — which auto-enrolled everyone silently in the cloud.

*Reminder: not legal advice. Get sign-off from a privacy attorney before shipping third-party voiceprinting, and treat Illinois, the EU, and the UK as the binding constraints for the design.*

---

## Sources

**BIPA (Illinois):**
- [Recording Law – BIPA Explained (740 ILCS 14)](https://www.recordinglaw.com/us-laws/data-privacy-laws/bipa/)
- [740 ILCS 14 full text (Justia, 2025)](https://law.justia.com/codes/illinois/chapter-740/act-740-ilcs-14/)
- [King & Spalding – Illinois BIPA Reform Takes Effect](https://www.kslaw.com/news-and-insights/illinois-bipa-reform-takes-effect)
- [Greenberg Traurig – 2024 amendment (electronic consent, single violation)](https://www.gtlaw.com/en/insights/2024/8/bipa-update-illinois-limits-liability-and-clarifies-electronic-consent-for-biometric-data-collection)
- [Davis Wright Tremaine – 7th Cir. damages limit retroactive](https://www.dwt.com/blogs/privacy--security-law-blog/2024/08/illinois-bipa-biometrics-law-amended-for-damages)
- [WilmerHale – 2024 BIPA litigation year in review](https://www.wilmerhale.com/en/insights/blogs/wilmerhale-privacy-and-cybersecurity-law/20250219-year-in-review-2024-bipa-litigation-takeaways)
- [Morrison Foerster – "Biometric identifiers must identify" (photo carve-out)](https://www.mofo.com/resources/insights/240503-getting-bipa-right-biometric-identifiers-must-identify)

**AI note-taker / voiceprint litigation:**
- [Bloomberg Law – Otter.ai BIPA class suit](https://news.bloomberglaw.com/artificial-intelligence/otter-ai-hit-with-bipa-class-suit-over-voice-print-collection)
- [National Law Review – privacy litigation targets Otter.ai](https://natlawreview.com/article/take-note-new-wave-privacy-litigation-targets-ai-notetaker-otterai)
- [Basil AI – In re Otter.AI Privacy Litigation (May 2026 hearing)](https://basilai.app/articles/2026-06-21-in-re-otter-ai-privacy-litigation-may-2026-hearing-explained.html)
- [Basil AI – BIPA lawsuit wave hitting AI meeting bots (2026)](https://basilai.app/articles/2026-05-02-ai-meeting-bots-voiceprint-harvesting-bipa-lawsuits-biometric-privacy.html)
- [UMEVO – How BIPA applies to AI voice recorders (diarization = voiceprint)](https://www.umevo.ai/blogs/ume-all-posts/how-biometric-privacy-laws-like-illinois-bipa-apply-to-ai-voice-recorders)

**Texas CUBI:**
- [Recording Law – Texas biometric privacy](https://www.recordinglaw.com/us-laws/data-privacy-laws/texas-data-privacy-laws/biometric-privacy/)
- [ITECS – Texas CUBI compliance guide 2026](https://itecsonline.com/post/texas-biometric-identifier-act-cubi-a-compliance-guide-for-businesses-capturing-fingerprints-faces-or-voices)
- [Security Industry Association – Texas AI law & biometrics (2025)](https://www.securityindustry.org/2025/06/24/groundbreaking-texas-ai-law-also-brings-needed-clarity-on-use-of-biometric-technologies-for-security/)

**Washington HB 1493:**
- [Hunton – Washington becomes third state with biometric law](https://www.hunton.com/privacy-and-cybersecurity-law-blog/washington-becomes-third-state-enact-biometric-privacy-law)
- [TermsFeed – Washington HB 1493](https://www.termsfeed.com/blog/washington-biometric-privacy-law-hb-1493/)
- [Inside Privacy – Washington third state](https://www.insideprivacy.com/united-states/state-legislatures/washington-becomes-the-third-state-with-a-biometric-law/)

**Comprehensive state privacy (CA/CO/etc., 2025–2026):**
- [Recording Law – California biometric privacy](https://www.recordinglaw.com/us-laws/data-privacy-laws/california-data-privacy-laws/biometric-privacy/)
- [Recording Law – US state privacy comparison (2026)](https://www.recordinglaw.com/us-laws/data-privacy-laws/us-state-privacy-laws-comparison/)
- [Consenteo – US state privacy law tracker 2026](https://www.consenteo.com/knowledge-hub/legal/us_state_privacy_law_tracker_2026)
- [Privacy World – 2025 state privacy roundup / 2026 outlook](https://www.privacyworld.blog/2025/12/2025-state-privacy-roundup-key-trends-and-california-developments-to-watch-in-2026/)

**Wiretap / recording consent:**
- [KTS Law – Wiretap laws in the United States (2024)](https://ktslaw.com/en/Insights/Alert/2024/7/Wiretap-Laws-in-the-United-States)
- [Reed Smith – Legality of AI-powered recording & transcription](https://www.employmentlawwatch.com/post/102ls2n/the-legality-of-ai-powered-recording-and-transcription)
- [Basil AI – Recording in two-party consent states (2026)](https://basilai.app/articles/2026-07-07-recording-meetings-two-party-consent-states-ai-notetaker-compliance-guide-2026.html)

**GDPR / EU / UK:**
- [Art. 9 GDPR – special categories (gdpr-info.eu)](https://gdpr-info.eu/art-9-gdpr/)
- [Secure Privacy – GDPR Art. 9 guide 2026](https://secureprivacy.ai/blog/gdpr-article-9-special-categories-lawful-processing-and-compliance-guide-2026)
- [GDPRLocal – biometric data compliance](https://gdprlocal.com/biometric-data-gdpr-compliance-made-simple/)
- [DILR.ai – voice biometric data security & GDPR](https://www.dilr.ai/blog/ai-voice-biometric-data-security-enterprise)

**Google Photos / Meta biometric settlements (the analogy):**
- [Top Class Actions – Google Photos $100M (Rivera)](https://topclassactions.com/lawsuit-settlements/closed-settlements/google-photos-face-recognition-privacy-100m-class-action-settlement/)
- [Recording Law – Texas/Meta $1.4B, Google CUBI theories](https://www.recordinglaw.com/us-laws/data-privacy-laws/texas-data-privacy-laws/biometric-privacy/)
