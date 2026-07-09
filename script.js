(function(){
  "use strict";

  // ---------- Firebase ----------
  const firebaseConfig = {
    apiKey: "AIzaSyDuX3aJPQ2FuEt-fTPTHp3s4EyXazKxvg4",
    authDomain: "les-os-du-destin.firebaseapp.com",
    databaseURL: "https://les-os-du-destin-default-rtdb.firebaseio.com",
    projectId: "les-os-du-destin",
    storageBucket: "les-os-du-destin.firebasestorage.app",
    messagingSenderId: "899033916812",
    appId: "1:899033916812:web:618e25d6c892bbd751e2a9"
  };
  firebase.initializeApp(firebaseConfig);
  const db = firebase.database();

  // ---------- Shared state (mirror of the room in Firebase, or local in solo mode) ----------
  let mode = null;            // 'solo' | 'multi'
  let roomId = null;
  let myPlayerId = null;
  let roomRef = null;
  let phase = 'setup';       // 'setup' | 'playing'
  let players = [];          // [{id, name, loadedDiceCount, diceSet}]
  let contenders = [];        // ids still in contention this round
  let statusMap = {};         // id -> 'active' | 'tied' | 'out-odd' | 'out-lower' | 'out-six' | 'winner'
  let diceState = {};         // id -> {dice:[], loadedFlags:[], rolled:false, rolling:false}
  let roundNumber = 1;
  let gameOver = false;
  let logEntries = [];
  let localRpTexts = {};      // id -> texte RP généré (purement local, jamais synchronisé)
  let gameHistory = [];       // {time, winner, total, sixes, players, rounds} — local par navigateur
  let knownPlayerIds = null;  // pour detecter les nouveaux arrivants (son de connexion)
  let previousGameOver = false; // pour detecter la transition vers une victoire (son de victoire)

  const numberWords = {1:'un',2:'deux',3:'trois',4:'quatre',5:'cinq',6:'six'};
  // Dés pipés : biaisés vers les faces paires (et le 6 en particulier).
  const LOADED_TABLE = [1,2,2,3,4,4,5,6,6,6];
  const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);
  const rollDie = (loaded) => loaded
    ? LOADED_TABLE[Math.floor(Math.random()*LOADED_TABLE.length)]
    : 1 + Math.floor(Math.random()*6);
  function rollThree(loadedCount){
    const n = Math.max(0, Math.min(3, loadedCount||0));
    const flags = [0,1,2].map(i => i < n);
    for(let i=flags.length-1;i>0;i--){
      const j = Math.floor(Math.random()*(i+1));
      [flags[i],flags[j]] = [flags[j],flags[i]];
    }
    return { dice: flags.map(rollDie), flags };
  }
  const sum = (arr) => arr.reduce((a,b)=>a+b,0);
  const countSix = (arr) => arr.filter(v=>v===6).length;
  const isEven = (n) => n % 2 === 0;
  const playerById = (id) => players.find(p=>p.id===id);
  function escapeHtml(s){
    return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function generateRoomCode(){
    let code = '';
    for(let i=0;i<5;i++) code += ROOM_CODE_CHARS[Math.floor(Math.random()*ROOM_CODE_CHARS.length)];
    return code;
  }
  function generatePlayerId(){
    return 'p' + Math.random().toString(36).slice(2, 10);
  }
  function showRoomError(msg){
    $('room-error').textContent = msg;
  }

  // ---------- Mutation helpers (routent vers Firebase en multi, ou l'etat local en solo) ----------
  function applyTopLevel(key, value){
    if(key === 'phase') phase = value;
    else if(key === 'roundNumber') roundNumber = value;
    else if(key === 'gameOver') gameOver = !!value;
    else if(key === 'logEntries') logEntries = Array.isArray(value) ? value : [];
    else if(key === 'contenders') contenders = value ? Object.keys(value) : [];
    else if(key === 'players') players = value ? Object.keys(value).map(id => ({ id, ...value[id] })) : [];
    else if(key === 'statusMap') statusMap = value || {};
    else if(key === 'diceState'){
      diceState = value || {};
      Object.keys(diceState).forEach(id => {
        if(!diceState[id].dice) diceState[id].dice = [];
        if(!diceState[id].loadedFlags) diceState[id].loadedFlags = [];
      });
    }
  }

  function applyNested(container, id, value){
    if(container === 'statusMap'){
      statusMap[id] = value;
    } else if(container === 'diceState'){
      diceState[id] = value;
      if(!diceState[id].dice) diceState[id].dice = [];
      if(!diceState[id].loadedFlags) diceState[id].loadedFlags = [];
    }
  }

  function applyLocalUpdate(updates){
    Object.keys(updates).forEach(path => {
      const parts = path.split('/');
      if(parts.length === 1){
        applyTopLevel(parts[0], updates[path]);
      } else if(parts.length === 2){
        applyNested(parts[0], parts[1], updates[path]);
      } else if(parts.length === 3 && parts[0] === 'players'){
        const player = players.find(p => p.id === parts[1]);
        if(player) player[parts[2]] = updates[path];
      }
    });
    renderAll();
  }

  function pushField(path, value){
    if(mode === 'multi') roomRef.child(path).set(value);
    else applyLocalUpdate({ [path]: value });
  }

  function pushMerge(path, partial){
    if(mode === 'multi'){
      roomRef.child(path).update(partial);
    } else {
      const parts = path.split('/');
      if(parts[0] === 'diceState'){
        diceState[parts[1]] = Object.assign({}, diceState[parts[1]], partial);
      }
      renderAll();
    }
  }

  function pushUpdate(updates){
    if(mode === 'multi') roomRef.update(updates);
    else applyLocalUpdate(updates);
  }

  // ---------- Room: create / join ----------
  $('create-room-btn').addEventListener('click', () => {
    const name = $('player-name-input-room').value.trim();
    if(!name){ showRoomError('Entre ton nom avant de créer une partie.'); return; }
    attemptCreateRoom(name, 0);
  });

  function attemptCreateRoom(name, attempt){
    const code = generateRoomCode();
    const ref = db.ref('rooms/' + code);
    ref.once('value').then(snap => {
      if(snap.exists()){
        if(attempt < 5) return attemptCreateRoom(name, attempt + 1);
        showRoomError("Impossible de créer une partie pour l'instant, réessaie.");
        return;
      }
      myPlayerId = generatePlayerId();
      ref.set({
        createdAt: firebase.database.ServerValue.TIMESTAMP,
        phase: 'setup',
        players: { [myPlayerId]: { name, loadedDiceCount: 0, diceSet: 'commun' } },
        contenders: {},
        statusMap: {},
        diceState: {},
        roundNumber: 1,
        gameOver: false,
        logEntries: []
      }).then(() => {
        mode = 'multi';
        roomId = code;
        roomRef = ref;
        sessionStorage.setItem('osDuDestinPlayerId_' + roomId, myPlayerId);
        history.replaceState(null, '', location.pathname + '?room=' + roomId);
        attachRoomListener();
      });
    }).catch(() => showRoomError("Connexion à Firebase impossible. Vérifie ta connexion."));
  }

  $('join-room-btn').addEventListener('click', () => {
    const name = $('player-name-input-room').value.trim();
    const code = $('join-room-input').value.trim().toUpperCase();
    if(!name){ showRoomError('Entre ton nom avant de rejoindre.'); return; }
    if(!code){ showRoomError('Entre le code de la partie.'); return; }
    joinRoom(code, name);
  });

  function joinRoom(code, name){
    const ref = db.ref('rooms/' + code);
    ref.once('value').then(snap => {
      if(!snap.exists()){ showRoomError('Aucune partie trouvée avec ce code.'); return; }
      myPlayerId = generatePlayerId();
      ref.child('players/' + myPlayerId).set({ name, loadedDiceCount: 0, diceSet: 'commun' }).then(() => {
        mode = 'multi';
        roomId = code;
        roomRef = ref;
        sessionStorage.setItem('osDuDestinPlayerId_' + roomId, myPlayerId);
        history.replaceState(null, '', location.pathname + '?room=' + roomId);
        attachRoomListener();
      });
    }).catch(() => showRoomError("Connexion à Firebase impossible. Vérifie ta connexion."));
  }

  function attachRoomListener(){
    $('room-panel').classList.add('hidden');
    roomRef.on('value', snap => applySnapshot(snap.val()));
  }

  $('leave-room-btn').addEventListener('click', () => {
    if(mode === 'multi'){
      if(roomRef && myPlayerId) roomRef.child('players/' + myPlayerId).remove();
      if(roomId) sessionStorage.removeItem('osDuDestinPlayerId_' + roomId);
    }
    location.href = location.pathname;
  });

  $('copy-invite-btn').addEventListener('click', () => {
    const url = location.origin + location.pathname + '?room=' + roomId;
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(url).then(() => {
        const btn = $('copy-invite-btn');
        btn.textContent = 'Copié !';
        setTimeout(() => { btn.textContent = "Copier le lien d'invitation"; }, 2000);
      }).catch(() => { prompt('Copie ce lien :', url); });
    } else {
      prompt('Copie ce lien :', url);
    }
  });

  // Rejoindre automatiquement si l'URL contient ?room=CODE et qu'on a déjà une identité connue
  (function tryAutoRejoin(){
    const urlRoom = new URLSearchParams(location.search).get('room');
    if(!urlRoom) return;
    const code = urlRoom.toUpperCase();
    $('join-room-input').value = code;
    const saved = sessionStorage.getItem('osDuDestinPlayerId_' + code);
    if(!saved) return;
    const ref = db.ref('rooms/' + code);
    ref.once('value').then(snap => {
      const val = snap.val();
      if(val && val.players && val.players[saved]){
        mode = 'multi';
        roomId = code;
        myPlayerId = saved;
        roomRef = ref;
        attachRoomListener();
      }
    }).catch(() => {});
  })();

  // ---------- Mode solo (une seule personne gere toute la table, hors-ligne) ----------
  $('solo-mode-btn').addEventListener('click', () => {
    mode = 'solo';
    phase = 'setup';
    players = [];
    contenders = [];
    statusMap = {};
    diceState = {};
    roundNumber = 1;
    gameOver = false;
    logEntries = [];
    localRpTexts = {};
    myPlayerId = null;
    $('room-panel').classList.add('hidden');
    renderAll();
  });

  $('solo-add-player-btn').addEventListener('click', () => {
    const input = $('solo-player-name-input');
    const name = input.value.trim();
    if(!name) return;
    const id = generatePlayerId();
    const current = {};
    players.forEach(p => { current[p.id] = { name: p.name, loadedDiceCount: p.loadedDiceCount, diceSet: p.diceSet }; });
    current[id] = { name, loadedDiceCount: 0, diceSet: 'commun' };
    pushField('players', current);
    input.value = '';
    input.focus();
  });

  $('solo-player-name-input').addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ $('solo-add-player-btn').click(); }
  });

  // ---------- Applique l'état reçu de Firebase et redessine tout ----------
  function applySnapshot(val){
    if(!val) return;
    phase = val.phase || 'setup';
    players = val.players ? Object.keys(val.players).map(id => ({ id, ...val.players[id] })) : [];
    contenders = val.contenders ? Object.keys(val.contenders) : [];
    statusMap = val.statusMap || {};
    diceState = val.diceState || {};
    contenders.forEach(id => {
      if(!diceState[id]) diceState[id] = { dice: [], loadedFlags: [], rolled:false, rolling:false };
      if(!diceState[id].dice) diceState[id].dice = [];
      if(!diceState[id].loadedFlags) diceState[id].loadedFlags = [];
    });
    roundNumber = val.roundNumber || 1;
    gameOver = !!val.gameOver;
    logEntries = Array.isArray(val.logEntries) ? val.logEntries : [];
    renderAll();
  }

  function renderAll(){
    const currentIds = players.map(p => p.id);
    if(knownPlayerIds === null){
      knownPlayerIds = new Set(currentIds);
    } else {
      const added = currentIds.filter(id => !knownPlayerIds.has(id));
      if(added.length > 0) playJoinSound();
      knownPlayerIds = new Set(currentIds);
    }
    if(gameOver && !previousGameOver) playWinSound();
    previousGameOver = gameOver;

    $('leave-room-btn').textContent = mode === 'solo' ? 'Retour à l\'accueil' : 'Quitter la partie';
    if(phase === 'setup'){
      $('setup-panel').classList.remove('hidden');
      $('game-panel').classList.add('hidden');
      $('log-panel').classList.add('hidden');
      $('room-code-bar').classList.toggle('hidden', mode !== 'multi');
      $('solo-add-row').classList.toggle('hidden', mode !== 'solo');
      if(mode === 'multi') $('room-code-text').textContent = roomId;
      renderSetup();
    } else {
      $('setup-panel').classList.add('hidden');
      $('game-panel').classList.remove('hidden');
      $('log-panel').classList.remove('hidden');
      $('roll-round-btn').classList.toggle('hidden', mode !== 'solo');
      // "Relancer" ne doit apparaitre qu'une fois la partie gagnee, pour eviter
      // qu'un joueur reinitialise les des en cours de manche et relance a l'infini.
      $('replay-btn').classList.toggle('hidden', !gameOver);
      renderGame();
      renderLog();
    }
  }

  // ---------- Setup phase (roster partagé) ----------
  function renderSetup(){
    const list = $('player-setup-list');
    if(players.length === 0){
      list.innerHTML = mode === 'solo'
        ? '<div class="empty-hint">Ajoute au moins deux personnages pour commencer.</div>'
        : '<div class="empty-hint">En attente de joueurs...</div>';
    } else {
      const setLabels = {commun: 'Set commun', luxe: 'Set de luxe', interdit: 'Set interdit'};
      list.innerHTML = players.map(p => {
        const mine = mode === 'multi' && p.id === myPlayerId;
        const editable = mode === 'solo' || mine;
        const setControl = editable ? `
            <select data-dice-set="${p.id}">
              <option value="commun" ${p.diceSet === 'commun' ? 'selected' : ''}>Set commun</option>
              <option value="luxe" ${p.diceSet === 'luxe' ? 'selected' : ''}>Set de luxe</option>
              <option value="interdit" ${p.diceSet === 'interdit' ? 'selected' : ''}>Set interdit</option>
            </select>`
          : `<span class="badge set-${p.diceSet}">${setLabels[p.diceSet]}</span>`;
        const loadedControl = editable ? `
            <select data-loaded-count="${p.id}">
              <option value="0" ${p.loadedDiceCount === 0 ? 'selected' : ''}>0</option>
              <option value="1" ${p.loadedDiceCount === 1 ? 'selected' : ''}>1</option>
              <option value="2" ${p.loadedDiceCount === 2 ? 'selected' : ''}>2</option>
              <option value="3" ${p.loadedDiceCount === 3 ? 'selected' : ''}>3</option>
            </select>`
          : (p.loadedDiceCount > 0 ? `<span class="badge loaded">${p.loadedDiceCount} dé(s) pipé(s)</span>` : '');
        const removeBtn = mode === 'solo' ? `<button class="secondary small" data-remove="${p.id}">✕</button>` : '';
        return `
          <div class="player-setup-row ${mine ? 'mine' : ''}">
            <span class="name">${escapeHtml(p.name)}${mine ? ' <em>(toi)</em>' : ''}</span>
            <label class="check small">Set de dés : ${setControl}</label>
            <label class="check small">Dés pipés : ${loadedControl}</label>
            ${removeBtn}
          </div>
        `;
      }).join('');
    }
    $('start-game-btn').disabled = players.length < 2;
  }

  $('player-setup-list').addEventListener('change', (e) => {
    const countSelect = e.target.closest('[data-loaded-count]');
    if(countSelect){
      const id = countSelect.getAttribute('data-loaded-count');
      if(mode === 'multi' && id !== myPlayerId) return;
      pushField('players/' + id + '/loadedDiceCount', Number(countSelect.value));
      return;
    }
    const setSelect = e.target.closest('[data-dice-set]');
    if(setSelect){
      const id = setSelect.getAttribute('data-dice-set');
      if(mode === 'multi' && id !== myPlayerId) return;
      pushField('players/' + id + '/diceSet', setSelect.value);
    }
  });

  $('player-setup-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if(!btn || mode !== 'solo') return;
    const id = btn.getAttribute('data-remove');
    const current = {};
    players.filter(p => p.id !== id).forEach(p => { current[p.id] = { name: p.name, loadedDiceCount: p.loadedDiceCount, diceSet: p.diceSet }; });
    pushField('players', current);
  });

  function beginGame(){
    const ids = players.map(p => p.id);
    const newStatusMap = {}; ids.forEach(id => newStatusMap[id] = 'active');
    const newDiceState = {}; ids.forEach(id => newDiceState[id] = { dice: [], loadedFlags: [], rolled:false, rolling:false });
    const newContenders = {}; ids.forEach(id => newContenders[id] = true);
    localRpTexts = {};
    pushUpdate({
      phase: 'playing',
      contenders: newContenders,
      statusMap: newStatusMap,
      diceState: newDiceState,
      roundNumber: 1,
      gameOver: false,
      logEntries: [{ text: `La partie commence autour de la table, ${players.length} joueurs osent tenter leur chance.`, type: 'info' }]
    });
  }
  $('start-game-btn').addEventListener('click', beginGame);
  $('replay-btn').addEventListener('click', beginGame);

  $('back-setup-btn').addEventListener('click', () => {
    pushField('phase', 'setup');
  });

  // ---------- Rolling (multi : chacun lance ses propres dés) ----------
  function rollMyDice(id){
    const player = playerById(id);
    if(!player) return;
    const diceSfx = $('dice-sfx');
    diceSfx.currentTime = 0;
    diceSfx.play().catch(() => {});
    pushMerge('diceState/' + id, { rolling: true, dice: [1,1,1], loadedFlags: [] });

    let ticks = 0;
    const interval = setInterval(() => {
      const { dice, flags } = rollThree(player.loadedDiceCount);
      pushMerge('diceState/' + id, { dice, loadedFlags: flags });
      ticks++;
      if(ticks >= 7){
        clearInterval(interval);
        const final = rollThree(player.loadedDiceCount);
        pushMerge('diceState/' + id, { dice: final.dice, loadedFlags: final.flags, rolled: true, rolling: false });
      }
    }, 90);
  }

  // ---------- Rolling (solo : on lance pour toute la table d'un coup) ----------
  function rollAllDice(){
    $('roll-round-btn').disabled = true;
    const diceSfx = $('dice-sfx');
    diceSfx.currentTime = 0;
    diceSfx.play().catch(() => {});

    const startUpdates = {};
    contenders.forEach(id => { startUpdates['diceState/' + id] = { dice: [1,1,1], loadedFlags: [], rolled:false, rolling:true }; });
    pushUpdate(startUpdates);

    let ticks = 0;
    const interval = setInterval(() => {
      const tickUpdates = {};
      contenders.forEach(id => {
        const { dice, flags } = rollThree(playerById(id).loadedDiceCount);
        tickUpdates['diceState/' + id] = { dice, loadedFlags: flags, rolled:false, rolling:true };
      });
      pushUpdate(tickUpdates);
      ticks++;
      if(ticks >= 7){
        clearInterval(interval);
        const finalUpdates = {};
        contenders.forEach(id => {
          const final = rollThree(playerById(id).loadedDiceCount);
          finalUpdates['diceState/' + id] = { dice: final.dice, loadedFlags: final.flags, rolled:true, rolling:false };
        });
        pushUpdate(finalUpdates);
      }
    }, 90);
  }
  $('roll-round-btn').addEventListener('click', rollAllDice);

  // ---------- Resolution ----------
  $('resolve-round-btn').addEventListener('click', resolveRound);

  function resolveRound(){
    const updates = {};
    const log = logEntries.slice();
    const evens = contenders.filter(id => isEven(sum(diceState[id].dice)));

    if(evens.length === 0){
      log.push({ text: `Aucune somme paire ce tour-ci — le sort hésite encore. Manche n°${roundNumber + 1}.`, type: 'warn' });
      contenders.forEach(id => { updates['diceState/' + id] = { dice: [], loadedFlags: [], rolled:false, rolling:false }; });
      updates['roundNumber'] = roundNumber + 1;
      updates['logEntries'] = log;
      pushUpdate(updates);
      return;
    }

    contenders.filter(id => !evens.includes(id)).forEach(id => {
      updates['statusMap/' + id] = 'out-odd';
      log.push({ text: `${playerById(id).name} obtient ${sum(diceState[id].dice)} (impair) — éliminé.`, type: 'info' });
    });

    const pool = evens;
    const maxTotal = Math.max(...pool.map(id => sum(diceState[id].dice)));
    const atMax = pool.filter(id => sum(diceState[id].dice) === maxTotal);
    pool.filter(id => !atMax.includes(id)).forEach(id => {
      updates['statusMap/' + id] = 'out-lower';
      log.push({ text: `${playerById(id).name} totalise ${sum(diceState[id].dice)} (pair, mais dépassé) — éliminé.`, type: 'info' });
    });

    if(atMax.length === 1){
      finalizeWinner(atMax[0], updates, log);
      return;
    }

    const maxSix = Math.max(...atMax.map(id => countSix(diceState[id].dice)));
    const atMaxSix = atMax.filter(id => countSix(diceState[id].dice) === maxSix);
    atMax.filter(id => !atMaxSix.includes(id)).forEach(id => {
      updates['statusMap/' + id] = 'out-six';
      log.push({ text: `${playerById(id).name} égalise la somme (${maxTotal}) mais avec moins de 6 — éliminé.`, type: 'info' });
    });

    if(atMaxSix.length === 1){
      finalizeWinner(atMaxSix[0], updates, log);
      return;
    }

    // égalité parfaite -> nouvelle manche de départage
    const newContenders = {};
    atMaxSix.forEach(id => {
      updates['statusMap/' + id] = 'tied';
      updates['diceState/' + id] = { dice: [], loadedFlags: [], rolled:false, rolling:false };
      newContenders[id] = true;
    });
    updates['contenders'] = newContenders;
    updates['roundNumber'] = roundNumber + 1;
    const names = atMaxSix.map(id => playerById(id).name).join(' et ');
    log.push({ text: `Égalité parfaite (${maxTotal}, ${maxSix} six) entre ${names} ! Manche n°${roundNumber + 1}.`, type: 'warn' });
    updates['logEntries'] = log;
    pushUpdate(updates);
  }

  function finalizeWinner(id, updates, log){
    updates['statusMap/' + id] = 'winner';
    updates['gameOver'] = true;
    const p = playerById(id);
    const ds = diceState[id];
    log.push({ text: `${p.name} remporte Les Os du Destin avec ${sum(ds.dice)} (${describeDiceGrouped(ds.dice)}) !`, type: 'win' });
    updates['logEntries'] = log;
    pushUpdate(updates);
    recordHistory({
      time: new Date().toLocaleString('fr-FR', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}),
      winner: p.name,
      total: sum(ds.dice),
      sixes: countSix(ds.dice),
      players: players.length,
      rounds: roundNumber
    });
  }

  // ---------- Historique des parties (local, par navigateur) ----------
  function loadHistory(){
    try{
      const raw = localStorage.getItem('osDuDestinHistory');
      gameHistory = raw ? JSON.parse(raw) : [];
    } catch(e){ gameHistory = []; }
  }

  function saveHistory(){
    try{ localStorage.setItem('osDuDestinHistory', JSON.stringify(gameHistory)); } catch(e){}
  }

  function recordHistory(entry){
    gameHistory.unshift(entry);
    gameHistory = gameHistory.slice(0, 20);
    saveHistory();
    renderHistory();
  }

  function renderHistory(){
    const el = $('history-log');
    if(gameHistory.length === 0){
      el.innerHTML = '<div class="empty-hint">Aucune partie terminée pour l\'instant.</div>';
      return;
    }
    el.innerHTML = gameHistory.map(g => `
      <div class="log-entry win">
        <img class="icon-crown" src="Image/couronne_os.png" alt=""> ${escapeHtml(g.winner)} — total ${g.total} (${g.sixes} six) — ${g.players} joueurs, ${g.rounds} manche(s) — ${escapeHtml(g.time)}
      </div>
    `).join('');
  }

  $('clear-history-btn').addEventListener('click', () => {
    gameHistory = [];
    saveHistory();
    renderHistory();
  });

  // ---------- RP text generator ----------
  const seqConnectors = ['un {w}', 'puis un {w}', 'puis encore un {w}', 'et enfin un {w}'];
  const groupAdjectives = ['misérables', 'insolents', 'ricanants', 'usés', 'chanceux', 'sournois'];
  const openings = [
    "{name} s'assied à la table, ses doigts frôlant les dés avec une nervosité mal cachée. Il les fait rouler d'un geste sec.",
    "D'un geste théâtral, {name} lance ses trois dés sur la table poisseuse de la taverne.",
    "{name} souffle sur ses dés comme pour leur murmurer une prière, puis les jette sans un regard en arrière.",
    "Sans un mot, {name} fait claquer les dés contre le bois usé de la table, sous les regards des autres joueurs.",
    "{name} secoue les dés dans son poing fermé, un sourire en coin, avant de les libérer d'un coup sec."
  ];
  const rollDescs = [
    "Les dés tournoient, ricochent contre une chope à moitié vide, puis s'immobilisent un à un.",
    "Ils roulent bruyamment sur le bois, cognent contre une pièce oubliée, et finissent par se figer.",
    "Un raclement sourd, puis plus rien : les dés se sont arrêtés au centre de la table.",
    "Ils rebondissent, hésitent au bord de la table, puis se stabilisent enfin."
  ];
  const closings_even = [
    "Total : {total}. Un chiffre pair — la chance semble, pour l'instant, de son côté.",
    "Total : {total}. {name} tapote la table du doigt, comme pour remercier le sort.",
    "Total : {total}. Un sourire discret échappe à {name} — la parité lui sourit."
  ];
  const closings_odd = [
    "Total : {total}. Un chiffre impair. {name} soupire, observant ses compagnons avec dépit.",
    "Total : {total}. {name} grimace — le sort ne lui est pas favorable ce tour-ci.",
    "Total : {total}. Un silence gêné suit l'annonce du chiffre impair."
  ];

  function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

  function sequentialDesc(dice){
    return dice.map((v,i) => seqConnectors[Math.min(i, seqConnectors.length-1)].replace('{w}', numberWords[v])).join(', ');
  }

  function describeDiceGrouped(dice){
    const counts = {};
    dice.forEach(v => counts[v] = (counts[v]||0) + 1);
    const parts = Object.keys(counts).sort((a,b)=>counts[b]-counts[a]).map(v => {
      const c = counts[v];
      if(c === 1) return `un ${numberWords[v]}`;
      const adj = pick(groupAdjectives);
      return `${numberWords[c]} ${adj} ${numberWords[v]}`;
    });
    return parts.join(', suivi de ');
  }

  function generateRpText(name, dice){
    const total = sum(dice);
    const useGrouped = Math.random() < 0.5;
    const diceText = useGrouped ? describeDiceGrouped(dice) : sequentialDesc(dice);
    const closing = isEven(total) ? pick(closings_even) : pick(closings_odd);
    return [
      pick(openings).replace('{name}', name),
      pick(rollDescs),
      diceText.charAt(0).toUpperCase() + diceText.slice(1) + '.',
      closing.replace('{total}', total).replace('{name}', name)
    ].join(' ');
  }

  // ---------- Render (jeu) ----------
  function statusBadge(id){
    const s = statusMap[id];
    if(s === 'winner') return '<span class="badge win"><img class="icon-crown" src="Image/couronne_os.png" alt=""> Vainqueur</span>';
    if(s === 'tied') return '<span class="badge tied">Égalité — départage</span>';
    if(s === 'out-odd') return '<span class="badge out">Éliminé — impair</span>';
    if(s === 'out-lower') return '<span class="badge out">Éliminé — somme faible</span>';
    if(s === 'out-six') return '<span class="badge out">Éliminé — moins de 6</span>';
    return '';
  }

  function renderGame(animating){
    $('round-title').textContent = `Manche ${roundNumber}`;

    $('players-grid').innerHTML = contenders.map(id => {
      const p = playerById(id);
      if(!p) return '';
      const ds = diceState[id] || { dice: [], loadedFlags: [], rolled:false, rolling:false };
      const eliminated = statusMap[id] && !['active', 'winner', 'tied'].includes(statusMap[id]);
      const isWinner = statusMap[id] === 'winner';
      const mine = mode === 'multi' && id === myPlayerId;
      const total = ds.dice.length === 3 ? sum(ds.dice) : null;
      const parity = total !== null ? (isEven(total) ? '<span class="parity even">(pair)</span>' : '<span class="parity odd">(impair)</span>') : '';

      const diceHtml = (ds.dice.length ? ds.dice : [0,0,0]).map((v, i) => {
        const cls = ['die'];
        if(ds.rolling) cls.push('rolling');
        if(ds.loadedFlags[i]) cls.push('loaded');
        if(!v){
          cls.push('placeholder');
          return `<div class="${cls.join(' ')}">?</div>`;
        }
        const variant = ds.loadedFlags[i] ? `pipes-${p.diceSet}` : p.diceSet;
        const src = `Image/des/les-os-du-destin/os-destin-${variant}-face-${v}.png`;
        return `<div class="${cls.join(' ')}"><img src="${src}" alt="Face ${v}"></div>`;
      }).join('');

      const loadedBadge = p.loadedDiceCount > 0
        ? `<span class="badge loaded">${p.loadedDiceCount} dé(s) pipé(s)</span>`
        : '';
      const setLabels = {commun: 'Set commun', luxe: 'Set de luxe', interdit: 'Set interdit'};
      const setBadge = `<span class="badge set-${p.diceSet}">${setLabels[p.diceSet]}</span>`;

      let rollBlock = '';
      if(mine && !eliminated && !isWinner && !ds.rolled && !ds.rolling){
        rollBlock = `<button class="roll-mine-btn" data-roll="${id}">Lancer mes dés</button>`;
      }

      let rpBlock = '';
      if(ds.rolled){
        rpBlock = `
          <div class="rp-box">
            <button class="secondary small" data-rp="${id}">📜 Générer le texte RP</button>
            <div class="rp-text" id="rp-${id}">${localRpTexts[id] ? escapeHtml(localRpTexts[id]) : ''}</div>
          </div>`;
      }

      return `
        <div class="card ${eliminated ? 'eliminated' : ''} ${isWinner ? 'winner' : ''} ${mine ? 'mine' : ''}">
          <div class="name-row">
            <span class="name">${escapeHtml(p.name)}${mine ? ' <em>(toi)</em>' : ''}</span>
            <div class="badges-row">${setBadge}${loadedBadge}${statusBadge(id)}</div>
          </div>
          <div class="dice-row">${diceHtml}</div>
          <div class="total-row">
            ${total !== null ? `<span class="total">Total : ${total}</span> ${parity}` : '<span class="total" style="opacity:.4">— — —</span>'}
          </div>
          ${rollBlock}
          ${rpBlock}
        </div>
      `;
    }).join('');

    const allRolled = contenders.length > 0 && contenders.every(id => diceState[id] && diceState[id].rolled);
    $('resolve-round-btn').disabled = gameOver || !allRolled;
    if(mode === 'solo'){
      const anyRolling = contenders.some(id => diceState[id] && diceState[id].rolling);
      $('roll-round-btn').disabled = gameOver || anyRolling || allRolled;
    }

    if(!animating) attachCardHandlers();
  }

  function attachCardHandlers(){
    document.querySelectorAll('[data-rp]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-rp');
        localRpTexts[id] = generateRpText(playerById(id).name, diceState[id].dice);
        $(`rp-${id}`).textContent = localRpTexts[id];
      });
    });
    document.querySelectorAll('[data-roll]').forEach(btn => {
      btn.addEventListener('click', () => rollMyDice(btn.getAttribute('data-roll')));
    });
  }

  function renderLog(){
    const log = $('log');
    const crown = '<img class="icon-crown" src="Image/couronne_os.png" alt=""> ';
    log.innerHTML = logEntries.map(e => `<div class="log-entry ${e.type}">${e.type === 'win' ? crown : ''}${escapeHtml(e.text)}</div>`).join('');
    log.scrollTop = log.scrollHeight;
  }

  // ---------- Musique ----------
  const bgMusic = $('bg-music');
  const diceSfxEl = $('dice-sfx');
  const joinSfxEl = $('join-sfx');
  const winSfxEl = $('win-sfx');
  let musicOn = false;
  let masterVolume = 0.7;

  function playJoinSound(){
    joinSfxEl.currentTime = 0;
    joinSfxEl.play().catch(() => {});
  }

  function playWinSound(){
    winSfxEl.currentTime = 0;
    winSfxEl.play().catch(() => {});
  }

  function loadVolume(){
    try{
      const raw = localStorage.getItem('osDuDestinVolume');
      if(raw !== null) masterVolume = Number(raw);
    } catch(e){}
  }

  function applyVolume(){
    bgMusic.volume = masterVolume;
    diceSfxEl.volume = masterVolume;
    joinSfxEl.volume = masterVolume;
    winSfxEl.volume = masterVolume;
    $('volume-slider').value = Math.round(masterVolume * 100);
  }

  $('volume-slider').addEventListener('input', (e) => {
    masterVolume = Number(e.target.value) / 100;
    bgMusic.volume = masterVolume;
    diceSfxEl.volume = masterVolume;
    joinSfxEl.volume = masterVolume;
    winSfxEl.volume = masterVolume;
    try{ localStorage.setItem('osDuDestinVolume', String(masterVolume)); } catch(e){}
  });

  $('music-toggle').addEventListener('click', () => {
    musicOn = !musicOn;
    if(musicOn){
      bgMusic.play().catch(() => { musicOn = false; $('music-toggle').textContent = '🔈 Musique'; });
      $('music-toggle').textContent = '🔊 Musique';
    } else {
      bgMusic.pause();
      $('music-toggle').textContent = '🔈 Musique';
    }
  });

  // ---------- init ----------
  loadVolume();
  applyVolume();
  loadHistory();
  renderHistory();
})();
