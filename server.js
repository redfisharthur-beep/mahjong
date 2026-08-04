const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ==========================================
// 1. 遊戲核心設定 (32張牌)
// ==========================================
const TILES_DECK = [
    '帥', '仕','仕', '相','相', '俥','俥', '傌','傌', '炮','炮', '兵','兵','兵','兵','兵',
    '將', '士','士', '象','象', '車','車', '馬','馬', '包','包', '卒','卒','卒','卒','卒'
];

const ROOM_COLORS = ['room-ruby', 'room-yellow', 'room-green', 'room-blue'];
const rooms = {};

// ==========================================
// 2. 核心：胡牌演算法 (修正支援跨色對子 + 正確分數)
// ==========================================
function checkWin(hand) {
    if (!hand || hand.length !== 5) return 0;
    const counts = {};
    hand.forEach(t => counts[t] = (counts[t] || 0) + 1);

    const hasSubset = (subset) => {
        let temp = { ...counts };
        for (let t of subset) {
            if (!temp[t] || temp[t] <= 0) return false;
            temp[t]--;
        }
        return true;
    };

    const checkPairInRemaining = (subset) => {
        let temp = { ...counts };
        for (let t of subset) temp[t]--;
        let rem = [];
        for (let t in temp) {
            for (let i = 0; i < temp[t]; i++) rem.push(t);
        }
        return rem.length === 2 && rem[0] === rem[1];
    };

    // ③ 兵兵兵兵兵 或 卒卒卒卒卒 (=10分)
    if (counts['兵'] === 5 || counts['卒'] === 5) return 10;

    // ⑤ 帥+將+兵兵兵 或 卒卒卒 (=8分)
    if (hasSubset(['帥', '將', '兵', '兵', '兵']) || hasSubset(['帥', '將', '卒', '卒', '卒'])) return 8;

    // ④ 除了將/帥以外：任意兩張相同棋子 + 兵兵兵 或 卒卒卒 (=5分，包含相相+卒卒卒跨色組合)
    const validPairs = ['仕', '相', '俥', '傌', '炮', '士', '象', '車', '馬', '包'];
    if (counts['兵'] === 3 || counts['卒'] === 3) {
        let pawnTile = counts['兵'] === 3 ? '兵' : '卒';
        let temp = { ...counts };
        temp[pawnTile] -= 3;
        for (let t in temp) {
            if (temp[t] === 2 && validPairs.includes(t)) return 5;
        }
    }

    // ① 帥仕相 / 將士象 + 對子 (=4分)
    if (hasSubset(['帥', '仕', '相']) && checkPairInRemaining(['帥', '仕', '相'])) return 4;
    if (hasSubset(['將', '士', '象']) && checkPairInRemaining(['將', '士', '象'])) return 4;

    // ② 俥傌炮 / 車馬包 + 對子 (=3分)
    if (hasSubset(['俥', '傌', '炮']) && checkPairInRemaining(['俥', '傌', '炮'])) return 3;
    if (hasSubset(['車', '馬', '包']) && checkPairInRemaining(['車', '馬', '包'])) return 3;

    return 0;
}

// ==========================================
// 3. 房間類別定義 (管理單一遊戲邏輯)
// ==========================================
class GameRoom {
    constructor(id, name, colorClass) {
        this.id = id;
        this.name = name;
        this.colorClass = colorClass;
        this.players = []; 
        this.maxRounds = 10;
        this.currentRound = 1;
        this.liuJuFirstPlayerId = null;
        this.resetGameState();
        this.stats = {};
    }

    resetGameState() {
        this.deck = [...TILES_DECK].sort(() => Math.random() - 0.5);
        this.discardPool = [];
        this.hands = {};
        this.phase = 'WAITING';
        this.currentTurnIndex = 0; 
        this.hasTakenCardThisTurn = false;
        this.lastDiscardBy = null;
        this.winningInfo = null;
        this.timeLeft = 8;
        clearInterval(this.interval);
    }

    initStats(pid) {
        if (!this.stats[pid]) {
            this.stats[pid] = { score: 0, hu: 0, fangQiang: 0, zimo: 0, liuJu: 0 };
        }
    }

    startTimer(seconds, callback) {
        clearInterval(this.interval);
        this.timeLeft = seconds;
        io.to(this.id).emit('timer_update', this.timeLeft);
        this.interval = setInterval(() => {
            this.timeLeft--;
            if (this.timeLeft > 0) {
                io.to(this.id).emit('timer_update', this.timeLeft);
            } else {
                clearInterval(this.interval);
                callback();
            }
        }, 1000);
    }

    broadcast() {
        io.to(this.id).emit('room_state_update', {
            id: this.id,
            phase: this.phase,
            currentRound: this.currentRound,
            maxRounds: this.maxRounds,
            players: this.players,
            discardPool: this.discardPool,
            myHands: this.hands,
            currentTurnIndex: this.currentTurnIndex,
            hasTakenCardThisTurn: this.hasTakenCardThisTurn,
            lastDiscardBy: this.lastDiscardBy,
            winningInfo: this.winningInfo,
            deckCount: this.deck.length
        });
    }

    startGame() {
        this.resetGameState();
        if (this.liuJuFirstPlayerId) {
            const idx = this.players.findIndex(p => p.id === this.liuJuFirstPlayerId);
            this.currentTurnIndex = idx !== -1 ? idx : 0;
            this.liuJuFirstPlayerId = null;
        }

        this.phase = 'PLAYING';
        this.players.forEach(p => {
            this.hands[p.id] = this.deck.splice(0, 4); 
            this.initStats(p.id);
            p.score = this.stats[p.id].score;
            p.nextReady = false; 
        });
        
        this.startTurn();
    }

    startTurn() {
        this.hasTakenCardThisTurn = false;
        this.phase = 'PLAYING';
        this.broadcast();
        
        this.startTimer(8, () => {
            let pid = this.players[this.currentTurnIndex].id;
            let hand = this.hands[pid];

            if (!this.hasTakenCardThisTurn) {
                if (this.deck.length > 0) {
                    hand.push(this.deck.pop());
                    this.hasTakenCardThisTurn = true;
                    this.broadcast(); 
                    
                    if (checkWin(hand) > 0) {
                        this.handleWin(pid, true);
                        return;
                    }
                } else {
                    this.handleLiuJu();
                    return;
                }
            }

            if (hand.length > 4) {
                let dropIdx = Math.floor(Math.random() * hand.length);
                let dropCard = hand.splice(dropIdx, 1)[0];
                this.handleDiscard(pid, dropCard);
            }
        });
    }

    handleDiscard(pid, tile) {
        clearInterval(this.interval);
        this.discardPool.push(tile);
        this.lastDiscardBy = pid;
        
        if (this.deck.length === 0) {
            return this.handleLiuJu();
        }

        this.nextPlayer(); 
    }

    nextPlayer() {
        this.currentTurnIndex = (this.currentTurnIndex + 1) % this.players.length;
        this.startTurn();
    }

    handleWin(winnerId, isZimo) {
        clearInterval(this.interval);
        const hand = this.hands[winnerId];
        const pts = checkWin(hand);
        const winner = this.players.find(p => p.id === winnerId);
        
        if (isZimo) {
            this.stats[winnerId].score += (pts * 2);
            this.stats[winnerId].zimo += 1;
            this.stats[winnerId].hu += 1;
            this.liuJuFirstPlayerId = winnerId;
        } else {
            this.stats[winnerId].score += pts;
            this.stats[winnerId].hu += 1;
            this.stats[this.lastDiscardBy].score -= pts;
            this.stats[this.lastDiscardBy].fangQiang += 1;
            this.liuJuFirstPlayerId = this.lastDiscardBy;
        }

        this.winningInfo = {
            title: isZimo ? `${winner.name} 自摸！ (+${pts*2}分)` : `${winner.name} 胡牌！ (+${pts}分)`,
            desc: isZimo ? '神抽自摸！' : `抓到 ${this.players.find(p=>p.id===this.lastDiscardBy).name} 放槍！`,
            winningHand: [...hand],
            winnerId: winnerId
        };
        this.endRound();
    }

    handleLiuJu() {
        clearInterval(this.interval);
        this.players.forEach(p => this.stats[p.id].liuJu += 1);
        this.winningInfo = { title: '流局', desc: '牌庫已盡，無人胡牌', winningHand: [] };
        this.endRound();
    }

    endRound() {
        this.phase = 'ROUND_OVER';
        this.players.forEach(p => { 
            p.score = this.stats[p.id].score; 
            p.isReady = false; 
            p.nextReady = false; 
        });
        this.broadcast();
        
        this.startTimer(5, () => {
            if (this.currentRound >= this.maxRounds) {
                this.phase = 'GAME_OVER';
                let ranks = this.players.map(p => ({ ...p, stats: this.stats[p.id] }))
                    .sort((a, b) => b.score - a.score);
                io.to(this.id).emit('game_over', { rankings: ranks });
            } else {
                this.currentRound++;
                this.startGame();
            }
        });
    }
}

// ==========================================
// 4. Socket.io 事件處理中心
// ==========================================
io.on('connection', socket => {
    console.log(`玩家連線: ${socket.id}`);
    socket.emit('room_list', rooms);

    socket.on('join_room', data => {
        let r = rooms[data.roomId];
        if (!r) {
            const colorIdx = Object.keys(rooms).length % 4;
            r = new GameRoom(data.roomId, `復原房間 ${Object.keys(rooms).length + 1}`, ROOM_COLORS[colorIdx]);
            rooms[data.roomId] = r;
        }

        if (r.players.length < 4 && r.phase === 'WAITING') {
            socket.join(r.id);
            r.players.push({ id: socket.id, name: data.playerName, score: 0, isReady: false, nextReady: false });
            
            io.to(r.id).emit('action_feedback', { message: `${data.playerName} 加入房間` });
            r.broadcast();
            io.emit('room_list', rooms);
        } else {
            socket.emit('action_feedback', { message: '房間已滿或遊戲已開始' });
        }
    });

    socket.on('player_ready', () => {
        const r = Object.values(rooms).find(rm => rm.players.find(p => p.id === socket.id));
        if (r && r.phase === 'WAITING') {
            let p = r.players.find(p => p.id === socket.id);
            if (p) p.isReady = true;
            r.broadcast();
            if (r.players.length >= 2 && r.players.every(pl => pl.isReady)) {
                r.currentRound = 1;
                r.players.forEach(pl => { if(r.stats[pl.id]) r.stats[pl.id] = { score: 0, hu: 0, fangQiang: 0, zimo: 0, liuJu: 0 }; pl.score = 0; });
                r.startGame();
            }
        }
    });

    socket.on('next_round_ready', () => {
        const r = Object.values(rooms).find(rm => rm.players.find(p => p.id === socket.id));
        if (r && r.phase === 'ROUND_OVER') {
            let p = r.players.find(p => p.id === socket.id);
            if (p) p.nextReady = true;
            r.broadcast();
            if (r.players.every(pl => pl.nextReady)) {
                r.currentRound++;
                r.startGame();
            }
        }
    });

    socket.on('player_action', data => {
        const r = rooms[data.roomId];
        if (!r || r.phase !== 'PLAYING') return;
        
        let isMyTurn = r.players[r.currentTurnIndex]?.id === socket.id;
        let hand = r.hands[socket.id];

        // 1. 摸牌
        if (data.actionType === 'draw' && isMyTurn && !r.hasTakenCardThisTurn) {
            clearInterval(r.interval);
            if (r.deck.length > 0) {
                hand.push(r.deck.pop());
                r.hasTakenCardThisTurn = true; 
                r.broadcast();
                if (checkWin(hand) > 0) return r.handleWin(socket.id, true);
                
                r.startTimer(8, () => {
                    if (hand.length > 4) {
                        let dropCard = hand.splice(Math.floor(Math.random() * hand.length), 1)[0];
                        r.handleDiscard(socket.id, dropCard);
                    }
                });
            } else {
                r.handleLiuJu();
            }
        } 
        // 2. 吃牌
        else if (data.actionType === 'eat' && isMyTurn && !r.hasTakenCardThisTurn) {
            if (r.discardPool.length > 0) {
                clearInterval(r.interval);
                hand.push(r.discardPool.pop());
                r.hasTakenCardThisTurn = true; 
                r.broadcast();
                
                if (checkWin(hand) > 0) return r.handleWin(socket.id, true); 

                r.startTimer(8, () => {
                     if (hand.length > 4) {
                         let dropCard = hand.splice(Math.floor(Math.random() * hand.length), 1)[0];
                         r.handleDiscard(socket.id, dropCard);
                     }
                });
            }
        }
        // 3. 胡牌
        else if (data.actionType === 'win') {
            if (!r.hasTakenCardThisTurn && r.discardPool.length > 0) {
                let fangQiangTile = r.discardPool[r.discardPool.length - 1];
                let testHand = [...hand, fangQiangTile];
                if (checkWin(testHand) > 0) {
                    r.hands[socket.id] = testHand;
                    r.discardPool.pop(); 
                    r.handleWin(socket.id, false);
                }
            } 
            else if (isMyTurn && r.hasTakenCardThisTurn && hand.length === 5) {
                if (checkWin(hand) > 0) r.handleWin(socket.id, true);
            }
        }
        // 4. 棄牌
        else if (data.actionType === 'discard' && isMyTurn && r.hasTakenCardThisTurn && hand.length > 4) {
            let idx = hand.indexOf(data.payload.tile);
            if (idx > -1) {
                hand.splice(idx, 1);
                r.handleDiscard(socket.id, data.payload.tile); 
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`玩家斷線: ${socket.id}`);
        Object.values(rooms).forEach(r => {
            const idx = r.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                let disconnectedPlayerName = r.players[idx].name;
                r.players.splice(idx, 1);
                
                if (r.players.length < 2 && r.phase !== 'WAITING') {
                    clearInterval(r.interval);
                    r.resetGameState();
                    r.phase = 'WAITING';
                    r.broadcast();
                    io.to(r.id).emit('action_feedback', { message: `${disconnectedPlayerName} 離開，人數不足，遊戲重置` });
                } else if (r.players.length >= 2 && r.phase === 'PLAYING') {
                     if (r.currentTurnIndex === idx) {
                         r.startTurn();
                     } else if (r.currentTurnIndex > idx) {
                         r.currentTurnIndex--; 
                         r.broadcast();
                     }
                } else {
                    r.broadcast();
                }
                io.emit('room_list', rooms);
            }
        });
    });
});

// 初始化 4 個預設房間
const defaultRooms = ['紅梅小棧', '金盞庭園', '翠竹居所', '碧海閣樓'];
defaultRooms.forEach((name, i) => {
    const id = `room${i+1}`;
    rooms[id] = new GameRoom(id, name, ROOM_COLORS[i]);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`伺服器啟動於端口 ${PORT}`));