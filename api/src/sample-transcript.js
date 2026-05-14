// 5-minute mock sales call used by POST /api/first-loop.
// Realistic single-objection-and-resolution shape so the analysis pipeline
// has a clean Moment-of-Truth to find.

module.exports = {
  meetingTitle: 'Helix Robotics × GhostStream — Discovery Call',
  durationSeconds: 285,
  participants: [
    { role: 'rep', name: 'Mike Patel', company: 'GhostStream' },
    { role: 'prospect', name: 'Sara Chen', company: 'Helix Robotics', title: 'CFO' },
  ],
  // [startSec, endSec, speaker, text]
  segments: [
    [0, 12, 'rep', "Hi Sara, thanks for jumping on. I wanted to walk you through how GhostStream helps your team close more deals with AI-powered roleplay practice and instant post-call portals."],
    [12, 28, 'prospect', "Sure. Before you start — what's the typical payback window? Not the marketing number. The one I can defend to my board."],
    [28, 55, 'rep', "Most of our customers see payback within four to six months based on increased win rate. We measure it on closed-won dollars, not pipeline."],
    [55, 80, 'prospect', "That's a wide range. What's the median, on what sample size, in which segment? Companies our size and stage."],
    [80, 130, 'rep', "For Series-C SaaS in your range — eighty to a hundred fifty million ARR — we've seen median payback of four-point-eight months across forty-seven customers in the last twelve months. Standard deviation is one-point-three months. I can share the underlying data."],
    [130, 145, 'prospect', "Better. What does this replace? You said your tool augments Gong. I'm not paying for two tools that do the same thing."],
    [145, 195, 'rep', "We replace your Gong call coaching add-on entirely. Our customers tell us our coaching is sharper because we train against custom AI personas modeled on their actual buyers, not generic playbooks. The Gong native recording stays; we replace their enablement layer."],
    [195, 235, 'prospect', "I'll take a look at the case study. Send me three things by end of week: a Series-C reference with closed-won math, your SOC 2 Type II report, and a pilot scope doc with one outcome metric and a kill clause. I'll loop in our VP Sales."],
    [235, 250, 'rep', "Done. I'll have it to you by Thursday end of day."],
    [250, 270, 'prospect', "Then we have a path forward. If the math holds up I'm prepared to authorize a sixty-day pilot with five reps. Thank you."],
    [270, 285, 'rep', "Appreciate it. Talk Thursday."],
  ],
};
