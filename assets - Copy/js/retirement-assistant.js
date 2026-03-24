(function () {
  /* ── CSS ── */
  const css = `
    :root{--brand-purple:#4E2C94;--brand-green:#389F72;--text:#1f2937;--muted:#6b7280;--bg:#ffffff;--shadow:0 12px 30px rgba(0,0,0,.16);--radius:18px}
    #plfs-ai-root{font-family:Arial,Helvetica,sans-serif}
    #plfs-ai-launcher{position:fixed;right:24px;bottom:24px;z-index:9999;width:62px;height:62px;border:none;border-radius:50%;background:var(--brand-purple);color:#fff;cursor:pointer;box-shadow:var(--shadow);font-size:26px;font-weight:700}
    #plfs-ai-nudge{position:fixed;right:24px;bottom:96px;z-index:9998;background:#fff;color:var(--text);padding:12px 14px;border-radius:14px;box-shadow:var(--shadow);max-width:240px;font-size:14px;line-height:1.4;display:none}
    #plfs-ai-panel{position:fixed;right:24px;bottom:100px;z-index:10000;width:380px;max-width:calc(100vw - 24px);height:620px;max-height:calc(100vh - 140px);background:#fff;border-radius:22px;box-shadow:var(--shadow);display:none;overflow:hidden;border:1px solid #ececec}
    #plfs-ai-header{background:var(--brand-purple);color:#fff;padding:16px 18px;display:flex;justify-content:space-between;align-items:center}
    #plfs-ai-header h3{margin:0;font-size:18px}
    #plfs-ai-header small{display:block;opacity:.9;margin-top:4px}
    .plfs-ai-header-actions button{background:rgba(255,255,255,.15);color:#fff;border:none;border-radius:10px;padding:8px 10px;cursor:pointer;margin-left:6px}
    #plfs-ai-body{height:calc(100% - 74px);display:flex;flex-direction:column;background:#f8fafc}
    #plfs-ai-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
    .msg{max-width:85%;padding:12px 14px;border-radius:16px;line-height:1.45;font-size:14px}
    .msg.bot{background:#fff;color:var(--text);box-shadow:0 2px 10px rgba(0,0,0,.06)}
    .msg.user{background:var(--brand-purple);color:#fff;align-self:flex-end}
    .typing{display:inline-flex;gap:4px;align-items:center}
    .typing span{width:7px;height:7px;border-radius:50%;background:#c4c4c4;animation:plfsb 1.2s infinite}
    .typing span:nth-child(2){animation-delay:.15s}.typing span:nth-child(3){animation-delay:.3s}
    @keyframes plfsb{0%,80%,100%{transform:scale(.7);opacity:.5}40%{transform:scale(1);opacity:1}}
    #plfs-ai-actions{padding:12px 14px;border-top:1px solid #e5e7eb;background:#fff}
    .quick-replies{display:flex;flex-wrap:wrap;gap:8px}
    .quick-replies button,.cta-btn,.send-btn{border:none;border-radius:12px;padding:10px 12px;cursor:pointer;font-size:14px}
    .quick-replies button{background:#eef2ff;color:var(--brand-purple);font-weight:600}
    .quick-replies button:hover{background:#e0e7ff}
    .cta-btn{background:var(--brand-green);color:#fff;font-weight:700;width:100%}
    .input-row{display:flex;gap:8px}
    .input-row input{flex:1;border:1px solid #d1d5db;border-radius:12px;padding:12px;font-size:14px}
    .send-btn{background:var(--brand-purple);color:#fff;font-weight:700}
    .lead-form{display:grid;gap:10px}
    .lead-form input{width:100%;padding:11px 12px;border-radius:12px;border:1px solid #d1d5db;font-size:14px;box-sizing:border-box}
    .tiny{font-size:12px;color:var(--muted);line-height:1.4}
    @media(max-width:640px){#plfs-ai-panel{right:10px;left:10px;bottom:84px;width:auto;height:72vh}#plfs-ai-launcher{right:14px;bottom:14px}#plfs-ai-nudge{right:14px;bottom:86px}}
  `;

  /* ── HTML ── */
  const html = `
    <div id="plfs-ai-nudge">Have questions about your retirement options?</div>
    <button id="plfs-ai-launcher" aria-label="Open retirement assistant">AI</button>
    <div id="plfs-ai-panel" aria-live="polite">
      <div id="plfs-ai-header">
        <div>
          <h3>Prosperity Retirement Assistant</h3>
          <small>Warm, professional guidance</small>
        </div>
        <div class="plfs-ai-header-actions">
          <button id="plfs-ai-restart">Restart</button>
          <button id="plfs-ai-close">&#x2715;</button>
        </div>
      </div>
      <div id="plfs-ai-body">
        <div id="plfs-ai-messages"></div>
        <div id="plfs-ai-actions"></div>
      </div>
    </div>
  `;

  /* ── INJECT ── */
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  const root = document.createElement('div');
  root.id = 'plfs-ai-root';
  root.innerHTML = html;
  document.body.appendChild(root);

  /* ── WIDGET LOGIC ── */
  const BOOKING_URL = 'book.html'; // ← swap for Calendly URL when ready

  const state = {
    topic: null,
    answers: {},
    lead: { firstName: '', email: '', phone: '' }
  };

  const el = {
    launcher: document.getElementById('plfs-ai-launcher'),
    nudge:    document.getElementById('plfs-ai-nudge'),
    panel:    document.getElementById('plfs-ai-panel'),
    messages: document.getElementById('plfs-ai-messages'),
    actions:  document.getElementById('plfs-ai-actions'),
    close:    document.getElementById('plfs-ai-close'),
    restart:  document.getElementById('plfs-ai-restart')
  };

  function openPanel() {
    el.panel.style.display = 'block';
    el.nudge.style.display = 'none';
    if (!el.messages.dataset.started) startConversation();
  }

  function closePanel() {
    el.panel.style.display = 'none';
  }

  function restartConversation() {
    state.topic   = null;
    state.answers = {};
    state.lead    = { firstName: '', email: '', phone: '' };
    el.messages.innerHTML = '';
    el.actions.innerHTML  = '';
    delete el.messages.dataset.started;
    startConversation();
  }

  function addMessage(text, who) {
    who = who || 'bot';
    const msg = document.createElement('div');
    msg.className = 'msg ' + who;
    msg.textContent = text;
    el.messages.appendChild(msg);
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function showTyping(cb) {
    const wrap = document.createElement('div');
    wrap.className = 'msg bot';
    wrap.id = 'plfs-typing';
    wrap.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
    el.messages.appendChild(wrap);
    el.messages.scrollTop = el.messages.scrollHeight;
    setTimeout(function () { wrap.remove(); cb(); }, 700);
  }

  function setQuickReplies(options) {
    el.actions.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'quick-replies';
    options.forEach(function (opt) {
      const btn = document.createElement('button');
      btn.textContent = opt.label;
      btn.onclick = opt.onClick;
      box.appendChild(btn);
    });
    el.actions.appendChild(box);
  }

  function setLeadForm(nextStep) {
    el.actions.innerHTML = `
      <div class="lead-form">
        <input id="lead-first" placeholder="First name" autocomplete="given-name" />
        <input id="lead-email" placeholder="Email address" type="email" autocomplete="email" />
        <input id="lead-phone" placeholder="Phone number" type="tel" autocomplete="tel" />
        <button class="cta-btn" id="lead-submit">Continue &rarr;</button>
        <div class="tiny">By continuing you agree to be contacted about your retirement planning questions. Message and data rates may apply.</div>
      </div>
    `;
    document.getElementById('lead-submit').onclick = function () {
      var fn    = document.getElementById('lead-first').value.trim();
      var email = document.getElementById('lead-email').value.trim();
      var phone = document.getElementById('lead-phone').value.trim();
      if (!fn || !email || !phone) {
        if (!fn)    document.getElementById('lead-first').style.borderColor = '#e05';
        if (!email) document.getElementById('lead-email').style.borderColor = '#e05';
        if (!phone) document.getElementById('lead-phone').style.borderColor = '#e05';
        return;
      }
      state.lead.firstName = fn;
      state.lead.email     = email;
      state.lead.phone     = phone;

      /* ── FUTURE INTEGRATION ────────────────────────────────────────
         Uncomment to push lead to a CRM / webhook:
         fetch('https://your-webhook.com/lead', {
           method: 'POST',
           headers: {'Content-Type':'application/json'},
           body: JSON.stringify({ ...state.lead, topic: state.topic, answers: state.answers })
         });
      ─────────────────────────────────────────────────────────────── */

      addMessage('My name is ' + fn + '.', 'user');
      nextStep();
    };
  }

  function setBookingCTA() {
    el.actions.innerHTML = `
      <button class="cta-btn" id="plfs-book-now">Schedule My Free Consultation</button>
      <div class="tiny" style="margin-top:8px;text-align:center;">You'll be taken to the booking page to choose a time that works for you.</div>
    `;
    document.getElementById('plfs-book-now').onclick = function () {
      window.open(BOOKING_URL, '_blank');
    };
  }

  function askChoice(question, key, choices, next) {
    showTyping(function () {
      addMessage(question, 'bot');
      setQuickReplies(choices.map(function (c) {
        return {
          label: c,
          onClick: function () {
            state.answers[key] = c;
            addMessage(c, 'user');
            next();
          }
        };
      }));
    });
  }

  function finalLeadAndBook(message) {
    showTyping(function () {
      addMessage(message, 'bot');
      setLeadForm(function () {
        showTyping(function () {
          addMessage('Thank you. Loretta can review your situation and help you explore your options — with no pressure and no obligation.', 'bot');
          setBookingCTA();
        });
      });
    });
  }

  /* ── FLOWS ── */
  function retirementFlow() {
    askChoice('Are you already retired or planning for retirement?', 'retired_status',
      ['Already retired', 'Planning for retirement'], function () {
      askChoice('About how soon are you planning to retire?', 'retire_timeline',
        ['Within 1 year', '1–3 years', '3–7 years', 'Just exploring'], function () {
        finalLeadAndBook('Would you like to speak with Loretta about your retirement options?');
      });
    });
  }

  function rolloverFlow() {
    askChoice('Which account are you looking to review?', 'account_type',
      ['401(k)', '403(b)', 'TSP', 'IRA', 'Multiple accounts'], function () {
      askChoice('Are you still employed, retired, or changing jobs?', 'employment_status',
        ['Still employed', 'Retired', 'Changing jobs'], function () {
        finalLeadAndBook('Would you like a free retirement review with Loretta?');
      });
    });
  }

  function safeMoneyFlow() {
    askChoice('Are you looking for growth, protection, or income?', 'goal_type',
      ['Growth', 'Protection', 'Income', 'A combination'], function () {
      askChoice('Are you concerned about market risk affecting your savings?', 'market_risk',
        ['Yes, very concerned', 'Somewhat concerned', 'Not too worried'], function () {
        finalLeadAndBook('Would you like to review safe money options with Loretta?');
      });
    });
  }

  function lifeInsuranceFlow() {
    askChoice('Are you looking for personal coverage, family protection, or final expense planning?', 'coverage_type',
      ['Personal coverage', 'Family protection', 'Final expense planning'], function () {
      finalLeadAndBook('Would you like to speak with Loretta about your coverage options?');
    });
  }

  function bookingDirect() {
    showTyping(function () {
      addMessage('I can help you schedule a free consultation with Loretta.', 'bot');
      setLeadForm(function () {
        showTyping(function () {
          addMessage('Thank you. You can now choose a time that works best for you.', 'bot');
          setBookingCTA();
        });
      });
    });
  }

  function startConversation() {
    el.messages.dataset.started = 'true';
    showTyping(function () {
      addMessage("Hello, I'm the Prosperity Retirement Assistant. I can help with retirement planning, rollovers, safe money options, and life insurance questions. What would you like help with today?", 'bot');
      setQuickReplies([
        { label: 'Retirement planning',           onClick: function () { state.topic = 'retirement';     addMessage('Retirement planning', 'user');           retirementFlow();    }},
        { label: '401(k) / 403(b) / TSP rollover',onClick: function () { state.topic = 'rollover';       addMessage('401(k) / 403(b) / TSP rollover', 'user'); rolloverFlow();      }},
        { label: 'Safe money strategies',          onClick: function () { state.topic = 'safe_money';     addMessage('Safe money strategies', 'user');          safeMoneyFlow();     }},
        { label: 'Life insurance',                 onClick: function () { state.topic = 'life_insurance'; addMessage('Life insurance', 'user');                  lifeInsuranceFlow(); }},
        { label: 'Book a free consultation',       onClick: function () { state.topic = 'booking';        addMessage('Book a free consultation', 'user');        bookingDirect();     }}
      ]);
    });
  }

  /* ── EVENTS ── */
  el.launcher.onclick = openPanel;
  el.close.onclick    = closePanel;
  el.restart.onclick  = restartConversation;

  setTimeout(function () {
    if (el.panel.style.display !== 'block') el.nudge.style.display = 'block';
  }, 8000);

})();
