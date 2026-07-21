"use strict";

var battle = execMain(function() {
	var accountDiv = $('<div>');
	var wcaSpan = $('<span class="click">');
	var uidSpan = $('<span class="click">');
	var headStr = TOOLS_BATTLE_HEAD.split('|');
	var joinRoomSpan = $('<span class="click">').html(headStr[1]);
	var leaveRoomSpan = $('<span class="click">').html('[X]');

	var conn = (function() {

		var socket;
		var isOpen = false;
		var idseq = 1;
		var waitList = [];
		var TIMEOUT = 5000;
		var callback = null;
		var toResolves = [];

		function connect() {
			if (isOpen) {
				return Promise.resolve();
			}
			return new Promise(function(resolve, reject) {
				toResolves.push(resolve);
				socket = new WebSocket('wss://cstimer.net/ws20230409');
				socket.onopen = onopen;
				socket.onclose = onclose;
				socket.onerror = onerror;
				socket.onmessage = onmessage;
			});
		}

		function remoteCall(msg) {
			return new Promise(function(resolve, reject) {
				if (!isOpen) {
					reject(-1);
					return;
				}
				msg['msgid'] = idseq;
				waitList[idseq] = resolve;
				idseq++;
				socket.send(JSON.stringify(msg));
				setTimeout(function(reject) {
					reject(-2);
				}.bind(null, reject), TIMEOUT);
			});
		}

		function pushMsg(msg) {
			if (!isOpen) {
				return -1;
			}
			socket.send(JSON.stringify(msg));
			return 0;
		}

		function onopen(e) {
			isOpen = true;
			while (toResolves.length > 0) {
				toResolves.pop()();
			}
		}

		function onclose(e) {
			isOpen = false;
			callback && callback('close');
		}

		function onerror(e) {
			isOpen = false;
			callback && callback('error');
		}

		function onmessage(e) {
			var msg = JSON.parse(e.data);
			var msgid = msg['msgid'];
			if (msgid in waitList) {
				var resolve = waitList[msgid];
				delete waitList[msgid];
				resolve(msg);
			} else {
				callback && callback('msg', msg);
			}
		}

		function setCallback(_callback) {
			callback = _callback;
		}

		function isConnected() {
			return isOpen;
		}

		function close() {
			if (!isOpen) {
				return -1;
			}
			socket.close();
			isOpen = false;
			return 0;
		}

		return {
			connect: connect,
			close: close,
			isConnected: isConnected,
			setCallback: setCallback,
			pushMsg: pushMsg,
			remoteCall: remoteCall
		}
	})();

	var heartBeatTid = 0;

	function resetHeartBeat(isTimeout) {
		if (!roomId || !compId || !conn.isConnected()) {
			return;
		}
		if (!isTimeout && heartBeatTid) {
			clearTimeout(heartBeatTid);
			heartBeatTid = 0;
		}
		if (isTimeout) {
			conn.pushMsg({
				'action': 'heartBeat',
				'roomId': roomId,
				'accountId': compId
			});
		}
		heartBeatTid = setTimeout(resetHeartBeat.bind(null, true), 15000);
	}

	function joinRoom(rstRoomId) {
		if (rstRoomId || !roomId) {
			var val = prompt(TOOLS_BATTLE_JOINALERT + ' [a-zA-Z0-9]', roomId || (100 + ~~(Math.random() * 900)));
			if (!/^[0-9a-zA-Z]{3,20}$/.exec(val)) {
				alert('invalid room ID');
				return;
			}
			roomId = val;
			delete clearedThroughRound[roomId];
		}
		if (!conn.isConnected()) {
			conn.connect().then(joinRoom.bind(null, false));
			return;
		}
		if (!checkConnState() || !roomId) {
			return;
		}
		conn.remoteCall({
			'action': 'joinRoom',
			'roomId': roomId,
			'accountId': compId,
			'scramble': scramble_333.getRandomScramble().trim()
		}).then(function(ret) {
			DEBUG && console.log('[battle] joinRoom ret=', JSON.stringify(ret));
			resetHeartBeat();
		});
	}

	function leaveRoom(direct) {
		if (!checkConnState(true) || !roomId) {
			return;
		}
		if (!direct) {
			if (!confirm(TOOLS_BATTLE_LEAVEALERT + '?')) {
				return;
			}
		}
		conn.remoteCall({
			'action': 'leaveRoom',
			'roomId': roomId,
			'accountId': compId
		}).then(conn.close, conn.close);
		roomInfo = null;
		renderRoom();
		resetHeartBeat();
	}

	function checkConnState(checkRoom) {
		if ((!roomInfo && checkRoom) || !conn.isConnected()) {
			compId = null;
			return compId;
		}
		compId = exportFunc.getDataId('wcaData', 'cstimer_token') || exportFunc.getDataId('locData', 'compid') || setCompId();
		return compId;
	}

	function submitStatus(status) {
		if (!checkConnState(true) || !roomId) {
			return;
		}
		conn.remoteCall({
			'action': 'updateStatus',
			'roomId': roomId,
			'accountId': compId,
			'status': status
		}).then(function(ret) {
			DEBUG && console.log('[battle] update status ret=', ret);
			resetHeartBeat();
		});
	}

	function submitSolve(time, isLast) {
		if (!checkConnState(true) || !roomId) {
			return;
		}
		var solvScr = time[1];
		if (solvScr != roomInfo['cur'][1] && solvScr != roomInfo['last'][1]) {
			return;
		}
		if (localLastSolve && localLastSolve[1] == time[1] && (!isLast || time[0][1] != localLastSolve[0][1])) {
			return;
		}
		localLastSolve = time;
		var solveId = solvScr == roomInfo['cur'][1] ? roomInfo['cur'][0] : roomInfo['last'][0];
		conn.remoteCall({
			'action': 'uploadSolve',
			'roomId': roomId,
			'accountId': compId,
			'solveId': solveId,
			'time': time,
			'scramble': scramble_333.getRandomScramble().trim()
		}).then(function(ret) {
			DEBUG && console.log('[battle] upload solve ret=', ret);
			resetHeartBeat();
		});
	}

	var roomId;
	var compId;
	var roomInfo;
	var toStart = false;
	var localLastSolve = [[-1, 1], null];

	var HISTORY_KEY = 'battleHistoryV1';
	var HISTORY_LIMIT = 100;
	var battleHistory = loadBattleHistory();
	var historyDiv;
	var resultOverlay;
	var clearedThroughRound = {};

	function loadBattleHistory() {
		try {
			var history = JSON.parse(localStorage[HISTORY_KEY] || '[]');
			if (!$.isArray(history)) {
				return [];
			}
			return history.filter(function(record) {
				return record && /^(?:WIN|LOSS|DRAW)$/.test(record['result']) && $.isArray(record['opponents']);
			}).slice(0, HISTORY_LIMIT);
		} catch (e) {
			return [];
		}
	}

	function saveBattleHistory() {
		try {
			localStorage[HISTORY_KEY] = JSON.stringify(battleHistory.slice(0, HISTORY_LIMIT));
		} catch (e) {
			DEBUG && console.log('[battle] unable to save history', e);
		}
	}

	function accountName(accountId) {
		accountId = String(accountId || 'Unknown');
		if (accountId.indexOf('|') != -1) {
			return accountId.split('|')[1];
		}
		if (accountId.length > 10) {
			return accountId.slice(0, 4) + '...' + accountId.slice(accountId.length - 3);
		}
		return accountId;
	}

	function isLocalAccount(accountId) {
		if (!compId || !accountId) {
			return false;
		}
		if (accountId == compId) {
			return true;
		}
		return /^[0-9a-f]{32}$/i.test(compId) && accountId.indexOf(compId.slice(0, 12) + '|') == 0;
	}

	function timeValue(time) {
		if (!$.isArray(time) || time.length < 2 || time[0] == -1) {
			return Infinity;
		}
		return (+time[0] || 0) + (+time[1] || 0);
	}

	function prettyBattleTime(time) {
		return $.isArray(time) ? stats.pretty(time, true) : 'N/A';
	}

	function countRecord(localAccountId, accountId) {
		var ret = { wins: 0, losses: 0, draws: 0 };
		for (var i = 0; i < battleHistory.length; i++) {
			var record = battleHistory[i];
			if (record['localAccountId'] != localAccountId) {
				continue;
			}
			var result = null;
			if (accountId == localAccountId) {
				result = record['result'];
			} else {
				for (var j = 0; j < record['opponents'].length; j++) {
					var opponent = record['opponents'][j];
					if (opponent['accountId'] == accountId) {
						result = opponent['result'] == 'WIN' ? 'LOSS' : opponent['result'] == 'LOSS' ? 'WIN' : 'DRAW';
						break;
					}
				}
			}
			if (result == 'WIN') {
				ret.wins++;
			} else if (result == 'LOSS') {
				ret.losses++;
			} else if (result == 'DRAW') {
				ret.draws++;
			}
		}
		return ret;
	}

	function recordText(localAccountId, accountId) {
		var record = countRecord(localAccountId, accountId);
		return record.wins + 'W-' + record.losses + 'L-' + record.draws + 'D';
	}

	function renderHistory() {
		if (!historyDiv) {
			return;
		}
		historyDiv.empty();
		var total = { wins: 0, losses: 0, draws: 0 };
		for (var i = 0; i < battleHistory.length; i++) {
			var result = battleHistory[i]['result'];
			total[result == 'WIN' ? 'wins' : result == 'LOSS' ? 'losses' : 'draws']++;
		}
		var clear = $('<span class="click battle-history-clear">').text('Clear').click(function() {
			if (!confirm('Clear all online battle records?')) {
				return;
			}
			battleHistory = [];
			localStorage.removeItem(HISTORY_KEY);
			if (roomInfo && roomInfo['last'] && roomInfo['last'][0] >= 0) {
				clearedThroughRound[roomInfo['roomId']] = roomInfo['last'][0];
			}
			renderRoom();
		});
		historyDiv.append($('<div class="battle-history-title">').append(
			$('<b>').text('Battle record: ' + total.wins + 'W-' + total.losses + 'L-' + total.draws + 'D'),
			' ', clear
		));
		if (!battleHistory.length) {
			historyDiv.append($('<div class="battle-history-empty">').text('No completed battles recorded yet.'));
			return;
		}
		var list = $('<div class="battle-history-list">');
		for (var i = 0; i < Math.min(10, battleHistory.length); i++) {
			var record = battleHistory[i];
			var opponentNames = [];
			var opponentTimes = [];
			for (var j = 0; j < record['opponents'].length; j++) {
				var opponent = record['opponents'][j];
				opponentNames.push(opponent['name']);
				opponentTimes.push(opponent['name'] + ' ' + prettyBattleTime(opponent['time']));
			}
			var item = $('<div class="battle-history-item">').addClass('battle-history-' + record['result'].toLowerCase());
			item.append($('<div>').append(
				$('<b>').text(record['result']),
				$('<span>').text(' vs ' + opponentNames.join(', '))
			));
			item.append($('<div class="battle-history-times">').text(
				'You ' + prettyBattleTime(record['localTime']) + ' | ' + opponentTimes.join(' | ')
			));
			item.append($('<div class="battle-history-meta">').text(new Date(record['finishedAt']).toLocaleString()));
			if (record['scramble']) {
				item.append($('<div class="battle-history-scramble">').text(record['scramble']));
			}
			list.append(item);
		}
		historyDiv.append(list);
	}

	function hideResultOverlay() {
		resultOverlay && resultOverlay.hide();
	}

	function showResultOverlay(record) {
		if (!resultOverlay) {
			return;
		}
		var opponentTimes = [];
		for (var i = 0; i < record['opponents'].length; i++) {
			var opponent = record['opponents'][i];
			opponentTimes.push(opponent['name'] + ' ' + prettyBattleTime(opponent['time']));
		}
		resultOverlay.hide().removeClass('battle-result-win battle-result-loss battle-result-draw').empty();
		resultOverlay.append(
			$('<div class="battle-result-label">').text(record['result']),
			$('<div class="battle-result-detail">').text('You ' + prettyBattleTime(record['localTime']) + ' | ' + opponentTimes.join(' | ')),
			$('<div class="battle-result-dismiss">').text('Press any key or click to continue')
		);
		resultOverlay[0].offsetWidth;
		resultOverlay.addClass('battle-result-' + record['result'].toLowerCase()).css('display', 'flex');
	}

	function processCompletedRound() {
		if (!roomInfo || !roomInfo['last'] || roomInfo['last'][0] < 0) {
			return;
		}
		var solveId = roomInfo['last'][0];
		if (roomInfo['roomId'] in clearedThroughRound && clearedThroughRound[roomInfo['roomId']] >= solveId) {
			return;
		}
		var players = roomInfo['players'] || [];
		var solveMap = {};
		for (var i = 0; i < roomInfo['solves'].length; i++) {
			var solve = roomInfo['solves'][i];
			if (solve['solveId'] == solveId) {
				solveMap[solve['accountId']] = solve;
			}
		}
		var localAccountId = null;
		for (var i = 0; i < players.length; i++) {
			if (!solveMap[players[i]['accountId']]) {
				return;
			}
			if (isLocalAccount(players[i]['accountId'])) {
				localAccountId = players[i]['accountId'];
			}
		}
		if (!localAccountId || players.length < 2) {
			return;
		}
		var localSolve = solveMap[localAccountId];
		var localValue = timeValue(localSolve['time']);
		var opponents = [];
		var overallResult = 'WIN';
		var finishedAt = +localSolve['soltime'] || +new Date();
		for (var i = 0; i < players.length; i++) {
			var accountId = players[i]['accountId'];
			if (accountId == localAccountId) {
				continue;
			}
			var opponentSolve = solveMap[accountId];
			var opponentValue = timeValue(opponentSolve['time']);
			var result = localValue < opponentValue ? 'WIN' : localValue > opponentValue ? 'LOSS' : 'DRAW';
			if (result == 'LOSS') {
				overallResult = 'LOSS';
			} else if (result == 'DRAW' && overallResult != 'LOSS') {
				overallResult = 'DRAW';
			}
			finishedAt = Math.max(finishedAt, +opponentSolve['soltime'] || 0);
			opponents.push({
				'accountId': accountId,
				'name': accountName(accountId),
				'time': opponentSolve['time'].slice(0),
				'result': result
			});
		}
		var opponentKey = opponents.map(function(opponent) { return opponent['accountId']; }).sort().join('|');
		var existing = -1;
		for (var i = 0; i < battleHistory.length; i++) {
			var record = battleHistory[i];
			var recordOpponentKey = record['opponents'].map(function(opponent) { return opponent['accountId']; }).sort().join('|');
			if (record['roomId'] == roomInfo['roomId'] && record['solveId'] == solveId && record['localAccountId'] == localAccountId &&
				recordOpponentKey == opponentKey && Math.abs(record['finishedAt'] - finishedAt) < 600000) {
				existing = i;
				break;
			}
		}
		var completed = {
			'roomId': roomInfo['roomId'],
			'solveId': solveId,
			'localAccountId': localAccountId,
			'result': overallResult,
			'localTime': localSolve['time'].slice(0),
			'opponents': opponents,
			'scramble': roomInfo['last'][1] || '',
			'finishedAt': finishedAt
		};
		if (existing != -1) {
			battleHistory[existing] = completed;
			saveBattleHistory();
			renderHistory();
			return;
		}
		battleHistory.unshift(completed);
		battleHistory = battleHistory.slice(0, HISTORY_LIMIT);
		saveBattleHistory();
		renderHistory();
		showResultOverlay(completed);
	}

	function onNotify(event, obj) {
		if (event == 'msg') {
			if ('roomInfo' in obj) {
				roomInfo = obj['roomInfo'];
				onRoomInfo();
			}
		} else {
			roomInfo = null;
			if (kernel.getProp('scrType') == 'remoteBattle') {
				kernel.pushSignal('ctrl', ['scramble', 'next']);
			}
		}
		renderRoom();
	}

	conn.setCallback(onNotify);

	function onRoomInfo() {
		if (!roomInfo) {
			return;
		}
		if (roomInfo['cur'][1] && roomInfo['cur'][1] != localLastSolve[1]) {
			scrResolve && scrResolve(['$T333$' + roomInfo['cur'][1]]);
			scrResolve = null;
			if (kernel.getProp('scrType') != 'remoteBattle') {
				kernel.setProp('scrType', 'remoteBattle');
			}
		}
		processCompletedRound();
	}

	var roomTable;

	function renderRoom() {
		DEBUG && console.log('[battle] render room', roomInfo);
		if (roomInfo) {
			accountDiv.hide();
		} else {
			accountDiv.show();
		}
		roomTable.empty();
		var titles = TOOLS_BATTLE_TITLE.split('|').slice(0, 3);
		titles.splice(1, 0, 'Record');

		roomTable.append($('<tr>').append($('<td colspan=5>').append(headStr[0] + ': ', joinRoomSpan, '&nbsp;', leaveRoomSpan)));
		roomTable.append('<tr><td colspan=2>' + titles.join('</td><td>') + '</td></tr>');
		joinRoomSpan.unbind('click');
		leaveRoomSpan.unbind('click');
		if (!roomInfo) {
			roomTable.append('<tr><td colspan=5 style="width:0;">' + TOOLS_BATTLE_INFO + '</td></tr>');
			joinRoomSpan.addClass('click').html(headStr[1]).click(joinRoom.bind(null, true));
			leaveRoomSpan.hide();
		} else {
			joinRoomSpan.removeClass('click').html(roomInfo['roomId']);
			leaveRoomSpan.click(leaveRoom.bind(null, false)).show();
			var players = roomInfo['players'];
			var solves = roomInfo['solves'];
			var solveDict = {};
			var hasSolved = false;
			var statusMap = ('???|' + TOOLS_BATTLE_STATUS).split('|');
			for (var i = 0; i < solves.length; i++) {
				var solveObj = solves[i];
				var accountId = solveObj['accountId'];
				solveDict[accountId] = solveDict[accountId] || {};
				solveDict[accountId][solveObj['solveId']] = [solveObj['time'], solveObj['soltime']];
				if (solveObj['solveId'] == roomInfo['cur'][0]) {
					hasSolved = true;
				}
			}
			var localAccountId = null;
			for (var i = 0; i < players.length; i++) {
				if (isLocalAccount(players[i]['accountId'])) {
					localAccountId = players[i]['accountId'];
				}
			}
			players.sort(function(a, b) {
				return b['elo'] - a['elo'];
			});
			var curSolveId = roomInfo['cur'][0];
			for (var i = 0; i < players.length; i++) {
				var player = players[i];
				var account = accountName(player['accountId']);
				var curTime = (solveDict[player['accountId']] || {})[curSolveId];
				var isSolved = player['status'] == 'SOLVED';
				var lastTime = (solveDict[player['accountId']] || {})[curSolveId - 1];
				lastTime = isSolved ? curTime : lastTime;
				lastTime = lastTime ? stats.pretty(lastTime[0], true) : 'N/A';
				if (hasSolved && !isSolved) {
					lastTime = $('<span>').css('color', '#888').text(lastTime);
				}
				var accountCell = $('<td>');
				if (player['accountId'].indexOf('|') != -1) {
					accountCell.append($('<b>').text(account));
				} else {
					accountCell.text(account);
				}
				roomTable.append($('<tr>').append(
					$('<td>').text(i + 1),
					accountCell,
					$('<td>').text(localAccountId ? recordText(localAccountId, player['accountId']) : '0W-0L-0D'),
					$('<td>').text(statusMap[['READY', 'INSPECT', 'SOLVING', 'SOLVED', 'LOSS'].indexOf(player['status']) + 1]),
					$('<td>').append(lastTime)
				));
			}
		}
		renderHistory();
	}

	function updateAccountDiv() {
		accountDiv.empty().append('ID: ');
		wcaSpan.empty();
		uidSpan.empty();

		var wcauid = exportFunc.getDataId('wcaData', 'cstimer_token');
		if (wcauid) {
			var wcaid = exportFunc.getDataId('wcaData', 'wca_me')['wca_id'];
			wcaSpan.append(wcaid || 'WCA Account', ' (WCA)').click(function() {
				exportFunc.logoutFromWCA(true);
				updateAccountDiv();
			});
			accountDiv.append(wcaSpan);
			return;
		} else {
			wcaSpan.append(EXPORT_LOGINWCA);
			wcaSpan.click(function() {
				location.href = exportFunc.wcaLoginUrl;
			});
		}
		var compid = exportFunc.getDataId('locData', 'compid');
		uidSpan.append((compid || 'N/A') + ' (' + OLCOMP_ANONYM + ')');
		accountDiv.append(uidSpan.unbind('click').click(setCompId), ' | ', wcaSpan);
	}

	function setCompId() {
		var compid = prompt(OLCOMP_SUBMITAS, exportFunc.getDataId('locData', 'compid'));
		if (compid == null) {
			return false;
		} else if (!exportFunc.isValidId(compid)) {
			alert(EXPORT_INVID);
			return false;
		}
		localStorage['locData'] = JSON.stringify({ id: exportFunc.getDataId('locData', 'id'), compid: compid });
		updateAccountDiv();
		return compid;
	}

	var isInit = false;

	function execFunc(fdiv, e) {
		if (!fdiv || isInit) {
			isInit = !!fdiv;
			if (!fdiv) {
				conn.close();
			}
			return;
		}
		fdiv.empty().append($('<div style="font-size: 0.75em; text-align: center;">')
			.append(accountDiv, roomTable, historyDiv));
		updateAccountDiv();
		renderRoom();
		isInit = true;
	}

	var solves = [];
	var submitted = false;
	var lastStatus = 'READY';

	function procSignal(signal, value) {
		if (!isInit) {
			return;
		}
		if (signal == 'export') {
			updateAccountDiv();
			return;
		}
		if (signal == 'timerStatus') {
			var status = 'READY';
			if (value > 0) {
				status = 'SOLVING';
			} else if (value < -2) {
				status = 'INSPECT';
			}
			if (status != lastStatus) {
				lastStatus = status;
				submitStatus(status);
			}
			return;
		}
		value = JSON.parse(JSON.stringify(value));
		if (signal == 'timestd') {
			submitSolve(value, false);
		} else if (signal == 'timepnt') {
			submitSolve(value, true);
		}
	}

	var scrResolve;

	function getScrambles() {
		if (!roomInfo) {
			return Promise.reject();
		}
		if (roomInfo['cur'][1] && roomInfo['cur'][1] != localLastSolve[1]) {
			return Promise.resolve(['$T333$' + roomInfo['cur'][1]]);
		}
		return new Promise(function(resolve, reject) {
			scrResolve = resolve;
		});
	}

	$(function() {
		roomTable = $('<table class="table">');
		historyDiv = $('<div class="battle-history">');
		resultOverlay = $('<div class="battle-result-overlay">').hide().click(hideResultOverlay).appendTo('body');
		document.addEventListener('keydown', function(event) {
			if (!resultOverlay.is(':visible')) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			hideResultOverlay();
		}, true);
		tools.regTool('battle', TOOLS_BATTLE, execFunc);
		kernel.regListener('battle', 'timestd', procSignal);
		kernel.regListener('battle', 'timepnt', procSignal);
		kernel.regListener('battle', 'timerStatus', procSignal);
		kernel.regListener('battle', 'export', procSignal, /^account$/);
	});

	return {
		getScrambles: getScrambles
	}
});
