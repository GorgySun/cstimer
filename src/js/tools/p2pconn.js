"use strict";

var p2pconn = (function() {
	var VERSION = 1;
	var OFFER_PREFIX = 'CSTP2P1-O:';
	var ANSWER_PREFIX = 'CSTP2P1-A:';
	var HASH_NAME = 'p2pbattle';
	var CONTROL_LABEL = 'battle-control-v1';
	var CHAT_LABEL = 'battle-chat-v1';
	var MAX_ENCODED_SIZE = 32768;
	var MAX_DECODED_SIZE = 65536;
	var MAX_MESSAGE_SIZE = 4096;
	var MAX_CHAT_LENGTH = 500;
	var ICE_GATHER_TIMEOUT = 15000;
	var CONNECTION_TIMEOUT = 30000;
	var CHAT_RATE_COUNT = 5;
	var CHAT_RATE_WINDOW = 10000;
	var RTC_CONFIG = {
		iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
		iceTransportPolicy: 'all'
	};

	function p2pError(code, detail) {
		var err = new Error(code);
		err.code = code;
		err.detail = detail || '';
		return err;
	}

	function safeCall(func) {
		if (!func) {
			return;
		}
		try {
			func.apply(null, Array.prototype.slice.call(arguments, 1));
		} catch (e) {
			if (window.DEBUG) {
				console.log('[p2pconn] callback error', e);
			}
		}
	}

	function randomSessionId() {
		var cryptoObj = window.crypto || window.msCrypto;
		if (!cryptoObj || !cryptoObj.getRandomValues) {
			throw p2pError('SECURE_RANDOM_UNAVAILABLE');
		}
		var bytes = new Uint8Array(16);
		cryptoObj.getRandomValues(bytes);
		var ret = '';
		for (var i = 0; i < bytes.length; i++) {
			ret += ('0' + bytes[i].toString(16)).slice(-2);
		}
		return ret;
	}

	function countCodePoints(value) {
		var count = 0;
		for (var i = 0; i < value.length; i++) {
			var code = value.charCodeAt(i);
			if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
				var next = value.charCodeAt(i + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					i++;
				}
			}
			count++;
		}
		return count;
	}

	function validateChatText(value) {
		if (typeof value != 'string' || !value.trim()) {
			throw p2pError('CHAT_EMPTY');
		}
		if (countCodePoints(value) > MAX_CHAT_LENGTH) {
			throw p2pError('CHAT_TOO_LONG');
		}
		return value;
	}

	function takeRateSlot(slots) {
		var now = +new Date();
		while (slots.length && now - slots[0] >= CHAT_RATE_WINDOW) {
			slots.shift();
		}
		if (slots.length >= CHAT_RATE_COUNT) {
			throw p2pError('CHAT_RATE_LIMIT');
		}
		slots.push(now);
	}

	function validateDescription(description, kind) {
		if (!description || description.type != kind || typeof description.sdp != 'string') {
			throw p2pError('INVALID_DESCRIPTION');
		}
		if (description.sdp.length < 4 || description.sdp.length > MAX_DECODED_SIZE || description.sdp.indexOf('v=0') != 0) {
			throw p2pError('INVALID_SDP');
		}
	}

	function encodeSignal(payload) {
		var raw = JSON.stringify(payload);
		if (raw.length > MAX_DECODED_SIZE) {
			throw p2pError('SIGNAL_TOO_LARGE');
		}
		var encoded = LZString.compressToEncodedURIComponent(raw);
		if (!encoded || encoded.length > MAX_ENCODED_SIZE) {
			throw p2pError('SIGNAL_TOO_LARGE');
		}
		return encoded;
	}

	function extractEncoded(input, expectedKind) {
		if (typeof input != 'string') {
			throw p2pError('INVALID_SIGNAL');
		}
		input = input.trim();
		var prefix = expectedKind == 'offer' ? OFFER_PREFIX : ANSWER_PREFIX;
		var encoded = null;
		if (input.indexOf(prefix) == 0) {
			encoded = input.slice(prefix.length);
		} else if (expectedKind == 'offer') {
			var match = /[#&]p2pbattle=([^&#]+)/.exec(input);
			if (match) {
				encoded = match[1];
			}
		}
		if (!encoded) {
			throw p2pError('INVALID_SIGNAL_PREFIX');
		}
		if (encoded.length > MAX_ENCODED_SIZE) {
			throw p2pError('SIGNAL_TOO_LARGE');
		}
		try {
			encoded = decodeURIComponent(encoded);
		} catch (e) {
			throw p2pError('INVALID_SIGNAL_ENCODING');
		}
		if (encoded.length > MAX_ENCODED_SIZE) {
			throw p2pError('SIGNAL_TOO_LARGE');
		}
		return encoded;
	}

	function parseSignal(input, expectedKind) {
		var encoded = extractEncoded(input, expectedKind);
		var raw = LZString.decompressFromEncodedURIComponent(encoded);
		if (!raw || raw.length > MAX_DECODED_SIZE) {
			throw p2pError('INVALID_SIGNAL_DATA');
		}
		var payload;
		try {
			payload = JSON.parse(raw);
		} catch (e) {
			throw p2pError('INVALID_SIGNAL_JSON');
		}
		if (!payload || payload.v !== VERSION) {
			throw p2pError('UNSUPPORTED_SIGNAL_VERSION');
		}
		if (payload.kind !== expectedKind) {
			throw p2pError('INVALID_SIGNAL_KIND');
		}
		if (typeof payload.sessionId != 'string' || !/^[0-9a-f]{32}$/.test(payload.sessionId)) {
			throw p2pError('INVALID_SESSION_ID');
		}
		if (typeof payload.createdAt != 'number' || !isFinite(payload.createdAt) || payload.createdAt <= 0) {
			throw p2pError('INVALID_CREATED_AT');
		}
		validateDescription(payload.description, expectedKind);
		return payload;
	}

	function waitForIceGathering(session) {
		var pc = session.pc;
		if (pc.iceGatheringState == 'complete') {
			return Promise.resolve(false);
		}
		return new Promise(function(resolve) {
			var finished = false;
			var timeoutId;
			function finish(timedOut) {
				if (finished) {
					return;
				}
				finished = true;
				clearTimeout(timeoutId);
				pc.removeEventListener('icegatheringstatechange', checkState);
				pc.removeEventListener('icecandidate', checkCandidate);
				if (timedOut) {
					session._diagnostic('ICE_GATHER_TIMEOUT');
				}
				resolve(timedOut);
			}
			function checkState() {
				if (pc.iceGatheringState == 'complete') {
					finish(false);
				}
			}
			function checkCandidate(event) {
				if (!event.candidate) {
					finish(false);
				}
			}
			pc.addEventListener('icegatheringstatechange', checkState);
			pc.addEventListener('icecandidate', checkCandidate);
			timeoutId = setTimeout(finish.bind(null, true), ICE_GATHER_TIMEOUT);
		});
	}

	function PeerSession(role, sessionId, callbacks) {
		this.role = role;
		this.sessionId = sessionId;
		this.callbacks = callbacks || {};
		this.state = null;
		this.pc = null;
		this.control = null;
		this.chat = null;
		this.offerEncoded = null;
		this.answerAccepted = false;
		this.closed = false;
		this.wasConnected = false;
		this.helloReceived = false;
		this.connectTimer = 0;
		this.disconnectTimer = 0;
		this.localChatSlots = [];
		this.remoteChatSlots = [];
		this.messageSeq = 1;
	}

	PeerSession.prototype._state = function(state, detail) {
		if (this.state == state && detail == null) {
			return;
		}
		this.state = state;
		safeCall(this.callbacks.onState, state, detail || '');
	};

	PeerSession.prototype._diagnostic = function(code, detail) {
		safeCall(this.callbacks.onDiagnostic, code, detail || '');
	};

	PeerSession.prototype._error = function(err) {
		safeCall(this.callbacks.onError, err);
		this._diagnostic(err.code || 'P2P_ERROR', err.detail || err.message || '');
	};

	PeerSession.prototype._sendRaw = function(channel, message) {
		if (!channel || channel.readyState != 'open') {
			throw p2pError('CHANNEL_NOT_OPEN');
		}
		var raw = JSON.stringify(message);
		if (raw.length > MAX_MESSAGE_SIZE) {
			throw p2pError('MESSAGE_TOO_LARGE');
		}
		channel.send(raw);
	};

	PeerSession.prototype._startConnectionTimeout = function() {
		if (this.connectTimer || this.closed || this.wasConnected) {
			return;
		}
		this.connectTimer = setTimeout(function() {
			this.connectTimer = 0;
			if (!this.wasConnected && !this.closed) {
				this._fail('DIRECT_CONNECTION_FAILED');
			}
		}.bind(this), CONNECTION_TIMEOUT);
	};

	PeerSession.prototype._clearTimers = function() {
		clearTimeout(this.connectTimer);
		clearTimeout(this.disconnectTimer);
		this.connectTimer = 0;
		this.disconnectTimer = 0;
	};

	PeerSession.prototype._fail = function(code, detail) {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this._clearTimers();
		try { this.control && this.control.close(); } catch (e) {}
		try { this.chat && this.chat.close(); } catch (e) {}
		try { this.pc && this.pc.close(); } catch (e) {}
		this._state(code, detail);
	};

	PeerSession.prototype._remoteClosed = function(reason) {
		this._fail(this.role == 'guest' ? 'HOST_GONE' : 'CLOSED', reason || 'PEER_CLOSED');
	};

	PeerSession.prototype._checkConnected = function() {
		if (this.closed || this.wasConnected || !this.control || !this.chat || this.control.readyState != 'open' || this.chat.readyState != 'open') {
			return;
		}
		this.wasConnected = true;
		this._clearTimers();
		this._state('CONNECTED');
		try {
			this._sendRaw(this.control, {
				v: VERSION,
				type: 'hello',
				sessionId: this.sessionId,
				role: this.role
			});
			this._sendRaw(this.control, {
				v: VERSION,
				type: 'ping',
				sessionId: this.sessionId,
				id: randomSessionId(),
				sentAt: +new Date()
			});
		} catch (e) {
			this._error(e);
		}
	};

	PeerSession.prototype._handlePcState = function() {
		if (this.closed || !this.pc) {
			return;
		}
		var state = this.pc.connectionState || this.pc.iceConnectionState;
		this._diagnostic('PEER_STATE', state);
		if (state == 'checking' || state == 'connecting') {
			this._startConnectionTimeout();
		} else if (state == 'failed') {
			this._fail('DIRECT_CONNECTION_FAILED');
		} else if (state == 'closed') {
			this._remoteClosed('PEER_CONNECTION_CLOSED');
		} else if (state == 'disconnected' && this.wasConnected && !this.disconnectTimer) {
			this.disconnectTimer = setTimeout(function() {
				this.disconnectTimer = 0;
				if (!this.closed && this.pc && (this.pc.connectionState == 'disconnected' || this.pc.iceConnectionState == 'disconnected')) {
					this._remoteClosed('PEER_DISCONNECTED');
				}
			}.bind(this), CONNECTION_TIMEOUT);
		} else if (state == 'connected') {
			clearTimeout(this.disconnectTimer);
			this.disconnectTimer = 0;
			this._checkConnected();
		}
	};

	PeerSession.prototype._setupPeerConnection = function() {
		var PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
		if (!PeerConnection) {
			throw p2pError('WEBRTC_UNAVAILABLE');
		}
		this.pc = new PeerConnection(RTC_CONFIG);
		this.pc.addEventListener('connectionstatechange', this._handlePcState.bind(this));
		this.pc.addEventListener('iceconnectionstatechange', this._handlePcState.bind(this));
		if (this.role == 'guest') {
			this.pc.addEventListener('datachannel', function(event) {
				if (event.channel.label == CONTROL_LABEL && !this.control) {
					this.control = event.channel;
					this._setupChannel(this.control, 'control');
				} else if (event.channel.label == CHAT_LABEL && !this.chat) {
					this.chat = event.channel;
					this._setupChannel(this.chat, 'chat');
				} else {
					event.channel.close();
				}
			}.bind(this));
		}
	};

	PeerSession.prototype._parseChannelMessage = function(event) {
		if (typeof event.data != 'string' || event.data.length > MAX_MESSAGE_SIZE) {
			throw p2pError('MESSAGE_TOO_LARGE');
		}
		var message;
		try {
			message = JSON.parse(event.data);
		} catch (e) {
			throw p2pError('INVALID_MESSAGE_JSON');
		}
		if (!message || message.v !== VERSION || message.sessionId !== this.sessionId || typeof message.type != 'string') {
			throw p2pError('INVALID_MESSAGE');
		}
		return message;
	};

	PeerSession.prototype._handleControlMessage = function(event) {
		try {
			var message = this._parseChannelMessage(event);
			if (message.type == 'hello') {
				if ((this.role == 'host' && message.role != 'guest') || (this.role == 'guest' && message.role != 'host')) {
					throw p2pError('INVALID_PEER_ROLE');
				}
				this.helloReceived = true;
				this._diagnostic('HELLO_RECEIVED', message.role);
			} else if (message.type == 'ping') {
				this._sendRaw(this.control, {
					v: VERSION,
					type: 'pong',
					sessionId: this.sessionId,
					id: message.id,
					sentAt: message.sentAt
				});
			} else if (message.type == 'pong') {
				this._diagnostic('PONG', '' + Math.max(0, +new Date() - (+message.sentAt || +new Date())) + 'ms');
			} else if (message.type == 'close') {
				this._remoteClosed(message.reason);
			} else if (message.type == 'control') {
				safeCall(this.callbacks.onControl, message.payload);
			} else {
				throw p2pError('UNKNOWN_CONTROL_MESSAGE');
			}
		} catch (e) {
			this._error(e.code ? e : p2pError('CONTROL_MESSAGE_FAILED', e.message));
		}
	};

	PeerSession.prototype._canonicalChat = function(sender, text, clientId) {
		return {
			v: VERSION,
			type: 'chatMessage',
			sessionId: this.sessionId,
			id: this.sessionId.slice(0, 8) + '-' + this.messageSeq++,
			clientId: clientId || null,
			sender: sender,
			text: text,
			sentAt: +new Date()
		};
	};

	PeerSession.prototype._handleChatMessage = function(event) {
		try {
			var message = this._parseChannelMessage(event);
			if (this.role == 'host' && message.type == 'chatSubmit') {
				takeRateSlot(this.remoteChatSlots);
				var text = validateChatText(message.text);
				var canonical = this._canonicalChat('guest', text, message.clientId);
				this._sendRaw(this.chat, canonical);
				safeCall(this.callbacks.onChat, canonical);
			} else if (this.role == 'guest' && message.type == 'chatMessage') {
				if ((message.sender != 'host' && message.sender != 'guest') || typeof message.id != 'string' || typeof message.sentAt != 'number') {
					throw p2pError('INVALID_CHAT_MESSAGE');
				}
				validateChatText(message.text);
				safeCall(this.callbacks.onChat, message);
			} else {
				throw p2pError('UNKNOWN_CHAT_MESSAGE');
			}
		} catch (e) {
			this._error(e.code ? e : p2pError('CHAT_MESSAGE_FAILED', e.message));
		}
	};

	PeerSession.prototype._setupChannel = function(channel, kind) {
		channel.addEventListener('open', function() {
			this._diagnostic('CHANNEL_OPEN', kind);
			this._checkConnected();
		}.bind(this));
		channel.addEventListener('close', function() {
			this._diagnostic('CHANNEL_CLOSED', kind);
			if (!this.closed) {
				this._remoteClosed(kind.toUpperCase() + '_CHANNEL_CLOSED');
			}
		}.bind(this));
		channel.addEventListener('error', function() {
			this._diagnostic('CHANNEL_ERROR', kind);
		}.bind(this));
		channel.addEventListener('message', kind == 'control' ? this._handleControlMessage.bind(this) : this._handleChatMessage.bind(this));
	};

	PeerSession.prototype.getOfferCode = function() {
		return this.offerEncoded ? OFFER_PREFIX + this.offerEncoded : null;
	};

	PeerSession.prototype.getOfferUrl = function() {
		if (!this.offerEncoded) {
			return null;
		}
		return window.location.href.split('#')[0] + '#' + HASH_NAME + '=' + this.offerEncoded;
	};

	PeerSession.prototype.acceptAnswer = function(input) {
		if (this.role != 'host') {
			return Promise.reject(p2pError('HOST_ONLY_OPERATION'));
		}
		if (this.answerAccepted || this.state != 'WAITING_FOR_ANSWER') {
			return Promise.reject(p2pError('ANSWER_ALREADY_ACCEPTED'));
		}
		var payload;
		try {
			payload = parseSignal(input, 'answer');
			if (payload.sessionId != this.sessionId) {
				throw p2pError('SESSION_MISMATCH');
			}
		} catch (e) {
			return Promise.reject(e);
		}
		this.answerAccepted = true;
		this._state('CONNECTING');
		this._startConnectionTimeout();
		return this.pc.setRemoteDescription(payload.description).catch(function(err) {
			this.answerAccepted = false;
			this._fail('DIRECT_CONNECTION_FAILED', err.message);
			throw p2pError('INVALID_REMOTE_ANSWER', err.message);
		}.bind(this));
	};

	PeerSession.prototype.sendControl = function(payload) {
		this._sendRaw(this.control, {
			v: VERSION,
			type: 'control',
			sessionId: this.sessionId,
			payload: payload
		});
	};

	PeerSession.prototype.sendChat = function(value) {
		var text = validateChatText(value);
		takeRateSlot(this.localChatSlots);
		if (this.role == 'host') {
			var canonical = this._canonicalChat('host', text, null);
			this._sendRaw(this.chat, canonical);
			safeCall(this.callbacks.onChat, canonical);
			return canonical.id;
		}
		var clientId = this.sessionId.slice(0, 8) + '-g-' + this.messageSeq++;
		this._sendRaw(this.chat, {
			v: VERSION,
			type: 'chatSubmit',
			sessionId: this.sessionId,
			clientId: clientId,
			text: text
		});
		return clientId;
	};

	PeerSession.prototype.close = function(reason) {
		if (this.closed) {
			return;
		}
		try {
			if (this.control && this.control.readyState == 'open') {
				this._sendRaw(this.control, {
					v: VERSION,
					type: 'close',
					sessionId: this.sessionId,
					reason: reason || 'LOCAL_CLOSE'
				});
			}
		} catch (e) {}
		this.closed = true;
		this._clearTimers();
		try { this.control && this.control.close(); } catch (e) {}
		try { this.chat && this.chat.close(); } catch (e) {}
		try { this.pc && this.pc.close(); } catch (e) {}
		this._state('CLOSED', reason || 'LOCAL_CLOSE');
	};

	function createHost(callbacks) {
		var session;
		try {
			session = new PeerSession('host', randomSessionId(), callbacks);
			session._state('CREATING_OFFER');
			session._setupPeerConnection();
			session.control = session.pc.createDataChannel(CONTROL_LABEL, { ordered: true });
			session.chat = session.pc.createDataChannel(CHAT_LABEL, { ordered: true });
			session._setupChannel(session.control, 'control');
			session._setupChannel(session.chat, 'chat');
		} catch (e) {
			return Promise.reject(e);
		}
		return session.pc.createOffer().then(function(offer) {
			return session.pc.setLocalDescription(offer);
		}).then(function() {
			return waitForIceGathering(session);
		}).then(function() {
			var description = {
				type: session.pc.localDescription.type,
				sdp: session.pc.localDescription.sdp
			};
			validateDescription(description, 'offer');
			session.offerEncoded = encodeSignal({
				v: VERSION,
				kind: 'offer',
				sessionId: session.sessionId,
				createdAt: +new Date(),
				description: description
			});
			session._state('WAITING_FOR_ANSWER');
			return session;
		}).catch(function(err) {
			session._fail('DIRECT_CONNECTION_FAILED', err.message);
			throw err.code ? err : p2pError('CREATE_OFFER_FAILED', err.message);
		});
	}

	function createGuest(input, callbacks) {
		var payload;
		var session;
		try {
			payload = parseSignal(input, 'offer');
			session = new PeerSession('guest', payload.sessionId, callbacks);
			session._state('CREATING_ANSWER');
			session._setupPeerConnection();
		} catch (e) {
			return Promise.reject(e);
		}
		return session.pc.setRemoteDescription(payload.description).then(function() {
			return session.pc.createAnswer();
		}).then(function(answer) {
			return session.pc.setLocalDescription(answer);
		}).then(function() {
			return waitForIceGathering(session);
		}).then(function() {
			var description = {
				type: session.pc.localDescription.type,
				sdp: session.pc.localDescription.sdp
			};
			validateDescription(description, 'answer');
			var encoded = encodeSignal({
				v: VERSION,
				kind: 'answer',
				sessionId: session.sessionId,
				createdAt: +new Date(),
				description: description
			});
			session._state('CONNECTING', 'SEND_ANSWER_TO_HOST');
			return {
				session: session,
				answerCode: ANSWER_PREFIX + encoded
			};
		}).catch(function(err) {
			session._fail('DIRECT_CONNECTION_FAILED', err.message);
			throw err.code ? err : p2pError('CREATE_ANSWER_FAILED', err.message);
		});
	}

	return {
		createHost: createHost,
		createGuest: createGuest,
		parseSignal: parseSignal,
		constants: {
			version: VERSION,
			offerPrefix: OFFER_PREFIX,
			answerPrefix: ANSWER_PREFIX,
			hashName: HASH_NAME,
			controlLabel: CONTROL_LABEL,
			chatLabel: CHAT_LABEL,
			maxChatLength: MAX_CHAT_LENGTH
		}
	};
})();
