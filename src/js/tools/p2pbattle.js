"use strict";

var p2pbattle = execMain(function() {
	var toolName = TOOLS_BATTLE + ' (P2P beta)';
	var session = null;
	var role = null;
	var busy = false;
	var currentState = 'IDLE';
	var statusDetail = '';
	var offerUrl = '';
	var offerCode = '';
	var answerCode = '';
	var diagnostics = [];
	var chatMessages = [];
	var currentFdiv = null;
	var inviteStatus = $('<div>');
	var inviteAnswer = $('<textarea readonly rows="6" style="width:95%;">');
	var inviteCopy = $('<input type="button">').val('Copy answer code');

	function safeDetail(detail) {
		detail = detail == null ? '' : String(detail);
		return detail.replace(/[\r\n\t]+/g, ' ').slice(0, 160);
	}

	function addDiagnostic(code, detail) {
		diagnostics.push({
			time: new Date(),
			code: safeDetail(code),
			detail: safeDetail(detail)
		});
		if (diagnostics.length > 100) {
			diagnostics.shift();
		}
		render();
	}

	function stateText(state, detail) {
		var labels = {
			IDLE: 'Not connected',
			CREATING_OFFER: 'Creating offer and gathering connection candidates...',
			WAITING_FOR_ANSWER: 'Waiting for the guest answer code',
			CREATING_ANSWER: 'Creating answer and gathering connection candidates...',
			CONNECTING: 'Connecting directly to the other player...',
			CONNECTED: 'Direct connection established',
			DIRECT_CONNECTION_FAILED: 'Direct connection unavailable without a relay server',
			HOST_GONE: 'The host connection ended',
			CLOSED: 'Connection closed'
		};
		var ret = labels[state] || state;
		return detail ? ret + ' (' + safeDetail(detail) + ')' : ret;
	}

	function handleState(state, detail) {
		currentState = state;
		statusDetail = detail || '';
		inviteStatus.text(stateText(state, detail));
		if (state == 'CONNECTED') {
			busy = false;
		} else if (state == 'DIRECT_CONNECTION_FAILED' || state == 'HOST_GONE' || state == 'CLOSED') {
			busy = false;
			chatMessages = [];
		}
		render();
	}

	function handleError(err) {
		var code = err && err.code || 'P2P_ERROR';
		var detail = err && (err.detail || err.message) || '';
		addDiagnostic(code, detail);
		statusDetail = code;
		busy = false;
		render();
	}

	function handleChat(message) {
		chatMessages.push(message);
		if (chatMessages.length > 200) {
			chatMessages.shift();
		}
		render();
	}

	function callbacks() {
		return {
			onState: handleState,
			onError: handleError,
			onDiagnostic: addDiagnostic,
			onControl: function(message) {
				addDiagnostic('CONTROL_MESSAGE', JSON.stringify(message).slice(0, 120));
			},
			onChat: handleChat
		};
	}

	function copyValue(value) {
		if (!value) {
			return;
		}
		$.clipboardCopy(value).then(function() {
			addDiagnostic('COPIED_TO_CLIPBOARD');
		}, function() {
			handleError({ code: 'CLIPBOARD_COPY_FAILED' });
		});
	}

	function closeSession(reason) {
		if (session) {
			session.close(reason || 'USER_ENDED');
		}
		session = null;
		role = null;
		busy = false;
		offerUrl = '';
		offerCode = '';
		answerCode = '';
		chatMessages = [];
		currentState = 'CLOSED';
		statusDetail = reason || 'USER_ENDED';
		render();
	}

	function createHost() {
		if (busy || session) {
			return;
		}
		busy = true;
		role = 'host';
		diagnostics = [];
		chatMessages = [];
		currentState = 'CREATING_OFFER';
		statusDetail = '';
		render();
		p2pconn.createHost(callbacks()).then(function(created) {
			session = created;
			offerUrl = session.getOfferUrl();
			offerCode = session.getOfferCode();
			busy = false;
			render();
		}, function(err) {
			session = null;
			role = null;
			handleError(err);
		});
	}

	function connectHost(answerInput) {
		if (busy || !session || role != 'host') {
			return;
		}
		busy = true;
		session.acceptAnswer(answerInput).then(function() {
			busy = false;
			render();
		}, function(err) {
			busy = false;
			handleError(err);
		});
	}

	function createGuest(offerInput, fromInvite) {
		if (busy || session) {
			return;
		}
		busy = true;
		role = 'guest';
		diagnostics = [];
		chatMessages = [];
		currentState = 'CREATING_ANSWER';
		statusDetail = '';
		render();
		p2pconn.createGuest(offerInput, callbacks()).then(function(result) {
			session = result.session;
			answerCode = result.answerCode;
			inviteAnswer.val(answerCode);
			busy = false;
			if (fromInvite) {
				$.clearHash(p2pconn.constants.hashName);
			}
			render();
		}, function(err) {
			session = null;
			role = null;
			inviteStatus.text(stateText('DIRECT_CONNECTION_FAILED', err.code || err.message));
			handleError(err);
		});
	}

	function makeButton(value, handler, disabled) {
		return $('<input type="button">').val(value).prop('disabled', !!disabled).click(handler);
	}

	function makeTextArea(value, readOnly, rows) {
		return $('<textarea>').attr('rows', rows || 4).css('width', '95%').prop('readonly', !!readOnly).val(value || '');
	}

	function appendLabelled(container, label, input, button) {
		container.append($('<div>').text(label), input);
		if (button) {
			container.append('<br>', button);
		}
		container.append('<br><br>');
	}

	function renderDiagnostics(container) {
		var details = $('<details>');
		details.append($('<summary>').text('Connection diagnostics (' + diagnostics.length + ')'));
		var log = $('<div style="max-height:8em;overflow:auto;text-align:left;font-size:0.8em;">');
		for (var i = 0; i < diagnostics.length; i++) {
			var item = diagnostics[i];
			var line = item.time.toLocaleTimeString() + ' ' + item.code;
			if (item.detail) {
				line += ': ' + item.detail;
			}
			log.append($('<div>').text(line));
		}
		details.append(log);
		container.append(details);
	}

	function renderChat(container) {
		var chat = $('<div>');
		chat.append($('<h4>').text('P2P chat'));
		var log = $('<div style="height:9em;overflow:auto;text-align:left;border:1px solid #888;padding:0.3em;">');
		for (var i = 0; i < chatMessages.length; i++) {
			var message = chatMessages[i];
			var row = $('<div>');
			var who = message.sender == role ? 'You' : (message.sender == 'host' ? 'Host' : 'Guest');
			row.append($('<b>').text(who + ': '), $('<span>').text(message.text));
			log.append(row);
		}
		chat.append(log);
		var input = makeTextArea('', false, 2).attr('maxlength', 1000).attr('placeholder', 'Message (max 500 characters)');
		function send() {
			if (!session || currentState != 'CONNECTED') {
				return;
			}
			try {
				session.sendChat(input.val());
				input.val('');
			} catch (e) {
				handleError(e);
			}
		}
		input.keydown(function(event) {
			if (event.keyCode == 13 && !event.shiftKey) {
				event.preventDefault();
				send();
			}
		});
		chat.append(input, '<br>', makeButton('Send', send, false));
		container.append(chat);
		setTimeout(function() {
			log.scrollTop(log[0].scrollHeight);
		}, 0);
	}

	function render() {
		if (!currentFdiv) {
			return;
		}
		var root = $('<div style="font-size:0.75em;text-align:center;">');
		root.append($('<div>').append($('<b>').text('Status: '), $('<span>').text(stateText(currentState, statusDetail))), '<br><br>');

		if (!session && !busy) {
			root.append(makeButton('Create offer (Host)', createHost, false), '<br><br>');
			var guestOffer = makeTextArea('', false, 5).attr('placeholder', 'Paste a CSTP2P1-O offer code or full offer link');
			root.append($('<div>').text('Join as guest'), guestOffer, '<br>', makeButton('Generate answer', function() {
				createGuest(guestOffer.val(), false);
			}, false), '<br><br>');
		}

		if (role == 'host' && session) {
			if (offerUrl) {
				appendLabelled(root, 'Offer link — send this to the guest', makeTextArea(offerUrl, true, 4), makeButton('Copy offer link', copyValue.bind(null, offerUrl), false));
				appendLabelled(root, 'Offer code fallback', makeTextArea(offerCode, true, 4), makeButton('Copy offer code', copyValue.bind(null, offerCode), false));
			}
			if (currentState == 'WAITING_FOR_ANSWER') {
				var hostAnswer = makeTextArea('', false, 5).attr('placeholder', 'Paste the CSTP2P1-A answer code returned by the guest');
				appendLabelled(root, 'Guest answer code', hostAnswer, makeButton('Connect', function() {
					connectHost(hostAnswer.val());
				}, busy));
			}
		}

		if (role == 'guest' && answerCode) {
			appendLabelled(root, 'Answer code — send this back to the host', makeTextArea(answerCode, true, 6), makeButton('Copy answer code', copyValue.bind(null, answerCode), false));
		}

		if (session) {
			root.append(makeButton('End connection', closeSession.bind(null, 'USER_ENDED'), false), '<br><br>');
		}
		if (session && currentState == 'CONNECTED') {
			renderChat(root);
		}
		renderDiagnostics(root);
		currentFdiv.empty().append(root);
	}

	function execFunc(fdiv) {
		if (!fdiv) {
			currentFdiv = null;
			return;
		}
		currentFdiv = fdiv;
		render();
	}

	function showInviteDialog(encodedOffer) {
		var inviteDiv = $('<div style="font-size:0.8em;text-align:center;">');
		inviteStatus.text('Importing P2P battle invitation...');
		inviteAnswer.val('');
		inviteCopy.unbind('click').click(function() {
			copyValue(inviteAnswer.val());
		});
		inviteDiv.append(inviteStatus, '<br><br>', $('<div>').text('Return this answer code to the host:'), inviteAnswer, '<br>', inviteCopy,
			'<br><br>', $('<div>').text('After connecting, open Tools → ' + toolName + ' to chat.'));
		kernel.showDialog([inviteDiv, undefined, $.noop, $.noop], 'share', toolName);
		createGuest(p2pconn.constants.offerPrefix + encodedOffer, true);
	}

	$(function() {
		tools.regTool('p2pbattle', toolName, execFunc);
		var encodedOffer = $.hashParam(p2pconn.constants.hashName);
		if (encodedOffer) {
			setTimeout(showInviteDialog.bind(null, encodedOffer), 0);
		}
		window.addEventListener('beforeunload', function() {
			if (session) {
				session.close('PAGE_UNLOAD');
			}
		});
	});

	return {
		close: closeSession
	};
});
