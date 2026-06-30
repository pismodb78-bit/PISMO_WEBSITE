const jwt = require('jsonwebtoken');

// ВАЖНО: секрет совпадает с JwtAuth.cs в десктопном клиенте
const JWT_SECRET = process.env.JWT_SECRET || 'uc5KT2e+qYwa6tb0HUXnLZwsC55VuB93szkSpkucr8i1BFjKA6RXbyIrjk0+ign9';

module.exports = function socketAuth(socket, next) {
    try {
        const token = socket.handshake.auth?.token;
        if (!token) {
            return next(new Error('AUTH_NO_TOKEN'));
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        socket.userId = decoded.id || decoded.uid;
        socket.userLogin = decoded.login;
        socket.userRole = decoded.role;
        next();
    } catch (err) {
        next(new Error('AUTH_INVALID_TOKEN'));
    }
};