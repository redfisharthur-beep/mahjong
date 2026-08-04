const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
// 允許跨域請求 (本地開發除錯用)
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

// 莫蘭迪配色設定
const ROOM_COLORS = ['room-ruby', 'room-yellow', 'room-green', 'room-blue'];

// 全域房間資料狀態 (存在記憶體中)
const rooms = {};

// ==========================================
// 2. 核心：胡牌演算法 (手牌 5 張時判斷)
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

    // ④ 任意同色兩張相同棋子(排除將/帥) + 兵兵兵 或 卒卒卒 (=5分)
    if (counts['兵'] >= 3) {
        let temp = { ...counts }; temp['兵'] -= 3;
        for (let t in temp) {
            if (temp[t] === 2 && t !== '帥' && t !== '將' && ['仕', '相', '俥', '傌', '炮'].includes(t)) return 5;
        }
    }
    if (counts['卒'] >= 3) {
        let temp = { ...counts }; temp['卒'] -= 3;
        for (let t in temp) {
            if (temp[t] === 2 && t !== '帥' && t !== '將' && ['士', '象', '車', '馬', '包'].includes(t)) return 5;
        }
    }

    // ① 帥仕相 / 將士象 + 對子 (=3分)
    if (hasSubset(['帥', '仕', '相']) && checkPairInRemaining(['帥', '仕', '相'])) return 3;
    if (hasSubset(['將', '士', '象']) && checkPairInRemaining(['將', '士', '象'])) return 3;

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
        this.liuJuFirstPlayerId = null; // 記錄流局時的優先摸牌者
        this.resetGameState();
        this.stats = {}; // 記錄十局統計數據
    }

    // 初始化/重置單局狀態
    resetGameState() {
        this.deck = [...TILES_DECK].sort(() => Math.random() - 0.5); // 洗牌
        this.discardPool = [];
        this.hands = {};
        this.phase = 'WAITING'; // WAITING, PLAYING, ROUND_OVER, GAME_OVER
        this.currentTurnIndex = 0; 
        this.hasTakenCardThisTurn = false;
        this.lastDiscardBy = null;
        this.winningInfo = null;
        this.timeLeft = 8;
        clearInterval(this.interval);
    }

    // 初始化統計數據
    initStats(pid) {
        if (!this.stats[pid]) {
            this.stats[pid] = { score: 0, hu: 0, fangQiang: 0, zimo: 0, liuJu: 0 };
        }
    }

    // 啟動 8 秒倒數計時
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
                callback(); // 時間到執行自動操作
            }
        }, 1000);
    }

    // 廣播當前房間完整狀態給所有玩家
    broadcast() {
        io.to(this.id).emit('room_state_update', {
            id: this.id,
            phase: this.phase,
            currentRound: this.currentRound,
            maxRounds: this.maxRounds,
            players: this.players,
            discardPool: this.discardPool,
            myHands: this.hands, // 前端會依 Socket.id 濾出自己的手牌
            currentTurnIndex: this.currentTurnIndex,
            hasTakenCardThisTurn: this.hasTakenCardThisTurn,
            lastDiscardBy: this.lastDiscardBy,
            winningInfo: this.winningInfo,
            deckCount: this.deck.length
        });
    }

    // 遊戲開始 (湊滿人數)
    startGame() {
        this.resetGameState();
        // 處理起手玩家順序 (胡牌/放槍/自摸)
        if (this.liuJuFirstPlayerId) {
            const idx = this.players.findIndex(p => p.id === this.liuJuFirstPlayerId);
            this.currentTurnIndex = idx !== -1 ? idx : 0;
            this.liuJuFirstPlayerId = null; // 用完重置
        }

        this.phase = 'PLAYING';
        // 發牌 4 張，初始化統計
        this.players.forEach(p => {
            this.hands[p.id] = this.deck.splice(0, 4); 
            this.initStats(p.id);
            p.score = this.stats[p.id].score; // 更新分數顯示
            p.nextReady = false; 
        });
        
        this.startTurn();
    }

    // 開始新回合 (換人或摸/吃牌後)
    startTurn() {
        this.hasTakenCardThisTurn = false;
        this.phase = 'PLAYING';
        this.broadcast();
        
        // 8秒超時機制：自動摸牌 + 自摸判斷 + 隨機棄牌
        this.startTimer(8, () => {
            let pid = this.players[this.currentTurnIndex].id;
            let hand = this.hands[pid];

            // 1. 如果超時還沒拿牌，強制摸牌
            if (!this.hasTakenCardThisTurn) {
                if (this.deck.length > 0) {
                    hand.push(this.deck.pop());
                    this.hasTakenCardThisTurn = true;
                    // 強制摸牌後需要立刻廣播，讓前端顯示胡牌按鈕
                    this.broadcast(); 
                    
                    // 2. 摸牌後檢查胡牌 (自摸)
                    if (checkWin(hand) > 0) {
                        this.handleWin(pid, true);
                        return;
                    }
                } else {
                    this.handleLiuJu();
                    return;
                }
            }

            // 3. 超時自動棄牌 (確保手上剩4張)
            if (hand.length > 4) {
                let dropIdx = Math.floor(Math.random() * hand.length);
                let dropCard = hand.splice(dropIdx, 1)[0];
                this.handleDiscard(pid, dropCard);
            }
        });
    }

    // 處理棄牌邏輯
    handleDiscard(pid, tile) {
        clearInterval(this.interval); // 停止當前倒數
        this.discardPool.push(tile);
        this.lastDiscardBy = pid;
        
        // 打完牌立刻檢查流局
        if (this.deck.length === 0) {
            return this.handleLiuJu();
        }

        // 切換到下一家，進入下一家的摸/吃牌選擇階段
        this.nextPlayer(); 
    }

    // 切換下一位玩家
    nextPlayer() {
        this.currentTurnIndex = (this.currentTurnIndex + 1) % this.players.length;
        this.startTurn(); // 開始下一家的 8 秒倒數
    }

    // 處理胡牌 (自摸或放槍)
    handleWin(winnerId, isZimo) {
        clearInterval(this.interval);
        const hand = this.hands[winnerId];
        const pts = checkWin(hand);
        const winner = this.players.find(p => p.id === winnerId);
        
        // 統計與計分
        if (isZimo) {
            this.stats[winnerId].score += (pts * 2); // 自摸兩倍
            this.stats[winnerId].zimo += 1;
            this.stats[winnerId].hu += 1;
            this.liuJuFirstPlayerId = winnerId; // 自摸者下把先
        } else {
            this.stats[winnerId].score += pts;
            this.stats[winnerId].hu += 1;
            this.stats[this.lastDiscardBy].score -= pts; // 放槍者扣分
            this.stats[this.lastDiscardBy].fangQiang += 1;
            this.liuJuFirstPlayerId = this.lastDiscardBy; // 放槍者下把先
        }

        // 胡牌成立：立即廣播結束本局，停止出牌
        this.winningInfo = {
            title: isZimo ? `${winner.name} 自摸！ (+${pts*2}分)` : `${winner.name} 胡牌！ (+${pts}分)`,
            desc: isZimo ? '神抽自摸！' : `抓到 ${this.players.find(p=>p.id===this.lastDiscardBy).name} 放槍！`,
            winningHand: [...hand], // 顯示胡牌組
            winnerId: winnerId
        };
        this.endRound();
    }

    // 處理流局
    handleLiuJu() {
        clearInterval(this.interval);
        this.players.forEach(p => this.stats[p.id].liuJu += 1);
        this.winningInfo = { title: '流局', desc: '牌庫已盡，無人胡牌', winningHand: [] };
        this.endRound();
    }

    // 結算本局，準備下一局或結束遊戲
    endRound() {
        this.phase = 'ROUND_OVER';
        // 更新分數顯示與 Ready 狀態
        this.players.forEach(p => { 
            p.score = this.stats[p.id].score; 
            p.isReady = false; 
            p.nextReady = false; 
        });
        this.broadcast();
        
        // 5秒自動 Ready 進下一局 (若有人未按)
        this.startTimer(5, () => {
            if (this.currentRound >= this.maxRounds) {
                // 十局結算，顯示排行榜
                this.phase = 'GAME_OVER';
                let ranks = this.players.map(p => ({ ...p, stats: this.stats[p.id] }))
                    .sort((a, b) => b.score - a.score);
                io.to(this.id).emit('game_over', { rankings: ranks });
            } else {
                // 自動 Ready 並開始新一局
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
    // 連線時立刻發送房間列表
    socket.emit('room_list', rooms);

    // 處理加入房間
    socket.on('join_room', data => {
        let r = rooms[data.roomId];
        if (!r) {
            // 房間若不存在則創建 (因 Render 休眠導致的狀況)
            const colorIdx = Object.keys(rooms).length % 4;
            r = new GameRoom(data.roomId, `復原房間 ${Object.keys(rooms).length + 1}`, ROOM_COLORS[colorIdx]);
            rooms[data.roomId] = r;
        }

        if (r.players.length < 4 && r.phase === 'WAITING') {
            socket.join(r.id);
            r.players.push({ id: socket.id, name: data.playerName, score: 0, isReady: false, nextReady: false });
            
            io.to(r.id).emit('action_feedback', { message: `${data.playerName} 加入房間` });
            r.broadcast();
            io.emit('room_list', rooms); // 更新全域房間列表人數
        } else {
            socket.emit('action_feedback', { message: '房間已滿或遊戲已開始' });
        }
    });

    // 處理初始準備
    socket.on('player_ready', () => {
        const r = Object.values(rooms).find(rm => rm.players.find(p => p.id === socket.id));
        if (r && r.phase === 'WAITING') {
            let p = r.players.find(p => p.id === socket.id);
            if (p) p.isReady = true;
            r.broadcast();
            // 2~4 人皆可開始，全部 Ready 就開局
            if (r.players.length >= 2 && r.players.every(pl => pl.isReady)) {
                r.currentRound = 1; // 重置為第一局
                // 重置所有統計
                r.players.forEach(pl => { if(r.stats[pl.id]) r.stats[pl.id] = { score: 0, hu: 0, fangQiang: 0, zimo: 0, liuJu: 0 }; pl.score = 0; });
                r.startGame();
            }
        }
    });

    // 處理局與局之間的 Ready
    socket.on('next_round_ready', () => {
        const r = Object.values(rooms).find(rm => rm.players.find(p => p.id === socket.id));
        if (r && r.phase === 'ROUND_OVER') {
            let p = r.players.find(p => p.id === socket.id);
            if (p) p.nextReady = true;
            r.broadcast();
            // 全部 Ready 提前開始新一局
            if (r.players.every(pl => pl.nextReady)) {
                r.currentRound++;
                r.startGame();
            }
        }
    });

    // 處理玩家操作 (摸牌、吃牌、胡牌、棄牌)
    socket.on('player_action', data => {
        const r = rooms[data.roomId];
        if (!r || r.phase !== 'PLAYING') return;
        
        let isMyTurn = r.players[r.currentTurnIndex]?.id === socket.id;
        let hand = r.hands[socket.id];

        // 1. 摸牌
        if (data.actionType === 'draw' && isMyTurn && !r.hasTakenCardThisTurn) {
            clearInterval(r.interval); // 停止倒數
            if (r.deck.length > 0) {
                hand.push(r.deck.pop());
                r.hasTakenCardThisTurn = true; 
                r.broadcast(); // 摸牌後廣播，讓前端更新胡牌按鈕
                // 摸牌後檢查自摸
                if (checkWin(hand) > 0) return r.handleWin(socket.id, true);
                
                // 摸完牌，開啟 8 秒棄牌倒數
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
        // 2. 吃牌 (下一家選擇拿取上一張棄牌)
        else if (data.actionType === 'eat' && isMyTurn && !r.hasTakenCardThisTurn) {
            if (r.discardPool.length > 0) {
                clearInterval(r.interval);
                hand.push(r.discardPool.pop()); // 拿取場上最後一張棄牌
                r.hasTakenCardThisTurn = true; 
                // 吃牌後廣播，此時手牌為5張，高亮消失，棄牌按鈕啟用
                r.broadcast();
                
                // 吃牌後檢查胡牌 (算自摸)
                if (checkWin(hand) > 0) return r.handleWin(socket.id, true); 

                // 吃完牌，開啟 8 秒棄牌倒數
                r.startTimer(8, () => {
                     if (hand.length > 4) {
                         let dropCard = hand.splice(Math.floor(Math.random() * hand.length), 1)[0];
                         r.handleDiscard(socket.id, dropCard);
                     }
                });
            }
        }
        // 3. 胡牌 (自摸或搶胡)
        else if (data.actionType === 'win') {
            // 搶胡判斷 (在別人棄牌，且還沒人摸/吃牌時)
            if (!r.hasTakenCardThisTurn && r.discardPool.length > 0) {
                let fangQiangTile = r.discardPool[r.discardPool.length - 1];
                let testHand = [...hand, fangQiangTile];
                if (checkWin(testHand) > 0) {
                    // 搶胡成功，將牌吸入原手牌進行結算
                    r.hands[socket.id] = testHand;
                    r.discardPool.pop(); 
                    r.handleWin(socket.id, false);
                }
            } 
            // 自摸判斷 (自己回合已拿牌)
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

    // 處理斷線
    socket.on('disconnect', () => {
        console.log(`玩家斷線: ${socket.id}`);
        Object.values(rooms).forEach(r => {
            const idx = r.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                let disconnectedPlayerName = r.players[idx].name;
                r.players.splice(idx, 1); // 移除玩家
                
                // 遊戲進行中若人數不足 2 人，強制重置
                if (r.players.length < 2 && r.phase !== 'WAITING') {
                    clearInterval(r.interval);
                    r.resetGameState();
                    r.phase = 'WAITING';
                    r.broadcast();
                    io.to(r.id).emit('action_feedback', { message: `${disconnectedPlayerName} 離開，人數不足，遊戲重置` });
                } else if (r.players.length >= 2 && r.phase === 'PLAYING') {
                     // 若斷線的是當前玩家，直接跳下一位
                     if (r.currentTurnIndex === idx) {
                         r.startTurn();
                     } else if (r.currentTurnIndex > idx) {
                         // 調整索引避免跳過人
                         r.currentTurnIndex--; 
                         r.broadcast();
                     }
                } else {
                    r.broadcast();
                }
                io.emit('room_list', rooms); // 更新大廳人數
            }
        });
    });
});

// 初始化四個預設房間 (莫蘭迪色)
const defaultRooms = ['紅梅小棧', '金盞庭園', '翠竹居所', '碧海閣樓'];
defaultRooms.forEach((name, i) => {
    const id = `room${i+1}`;
    rooms[id] = new GameRoom(id, name, ROOM_COLORS[i]);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`伺服器啟動於端口 ${PORT}`));