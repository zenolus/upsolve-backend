const request = require('request')
const express = require('express')
const app = express()
const mongoose = require('mongoose')
require('dotenv').config()
var isCFdown = false
var usercount = 0
const PORT = process.env.PORT || 8080
const mURL = process.env.MONGO_URL

mongoose.connect(mURL, { useNewUrlParser: true, useUnifiedTopology: true })

const userSchema = new mongoose.Schema({
    handle: String,
    data: Object,
})

const User = mongoose.model('User', userSchema)

app.use(function (req, res, next){
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
    res.setHeader('Access-Control-Allow-Credentials', true);
    next();
});

var problemData = {};
var tagSlabs = [[], [], [], [], [], []];  // <1200, <1600, <1900, <2100, <2400, >2400

const checkCFdown = () => {
    request(`https://codeforces.com/api/user.info?handles=MikeMirzayanov`, (err, res, body) => {
        try{
            const data = JSON.parse(res.body)
            isCFdown = data["status"] !== "OK"
        }
        catch(error){
            isCFdown = true
        }
    })
}

const updateUC = () => {
    User.countDocuments({}, (err, result) => {
        if(err){
            console.log("Error getting user count!")
            setTimeout(updateUC, 1000*10);
        }
        else{
            usercount = result
            console.log("User count updated:", usercount)
        }
    })
}

const getCFData = () => {
    if(isCFdown)    setTimeout(getCFData, 1000)
    else
    request(`https://codeforces.com/api/problemset.problems`, (error, response, body) => {
        try{
            const data = (JSON.parse(response.body))["result"]
            problemData = {}
            tagSlabs = [[], [], [], [], [], []]
            data["problems"].filter(problem => problem["index"] >= 'A').forEach(problem => {
                const pid = problem["contestId"]+problem["index"]
                problemData[pid] = {
                    "name" : problem["name"],
                    "tags" : problem["tags"],
                    "contestId" : problem["contestId"],
                    "index" : problem["index"],
                    "rating" : problem["rating"] || 0,
                }
                const rating = problemData[pid]["rating"];
                if(rating === -1)   return
                let slabIndex = -1;
                if(rating >= 2400)   slabIndex = 5;
                else if(rating >= 2100) slabIndex = 4;
                else if(rating >= 1900) slabIndex = 3;
                else if(rating >= 1600) slabIndex = 2;
                else if(rating >= 1200) slabIndex = 1;
                else    slabIndex = 0;
                problem["tags"].forEach(tag => {
                    let tagFound = 0;
                    tagSlabs[slabIndex].forEach((_tag, idx) => {
                        if(_tag.name === tag){
                            tagSlabs[slabIndex][idx].count++
                            tagFound = 1
                        }
                    })
                    if(!tagFound)   tagSlabs[slabIndex].push({
                        name : tag,
                        count : 1
                    })
                })
            })
            data["problemStatistics"].forEach(problem => {
                const pid = problem["contestId"]+problem["index"]
                if(problemData[pid] === undefined)  return
                problemData[pid]["solvedBy"] = problem["solvedCount"] || 0
            })
            tagSlabs.forEach(ts => ts.sort((a, b) => a.count - b.count))
            console.log("Problemset Parsed!")
        }
        catch(err){
            console.log("Error parsing problemset!")
            setTimeout(getCFData, 10*1000)
        }
    })
}

const userSlab = userRating => {
    var userSlabIndex = 0;
    if(userRating >= 2400)   userSlabIndex = 5;
    else if(userRating >= 2100) userSlabIndex = 4;
    else if(userRating >= 1900) userSlabIndex = 3;
    else if(userRating >= 1600) userSlabIndex = 2;
    else if(userRating >= 1200) userSlabIndex = 1;
    else    userSlabIndex = 0;
    return userSlabIndex
}

const processRequest = (handle, counts, response, low, high) => {
    
    var userSlabIndex = -1, userRating = 0, newUser = false, lastContest = 0, solvability = 10000
    const returnObject = {}
    var AC = new Set(), snoozed = new Set(), touched = new Set()
    var dbUser = {
        handle,
        data : {
            AC : [],
            snoozed : [],
            lastSubID : 0
        }
    }
    const getSuggestion = () => {
        var easy = [], medium = [], hard = [], upsolve = [], past = {easy: [], medium: [], hard: []}
        let subMax = 0
        userRating = Math.floor(userRating/100)*100
        if(low === undefined)   low = userRating - 200
        if(high === undefined)  high = userRating + 400
        returnObject.ratingLow = low
        returnObject.ratingHigh = high
        returnObject.problemData = {}
        for(var problem in problemData){
            if(problemData[problem]["rating"] < low || problemData[problem]["rating"] > high)  continue
            subMax = Math.max(subMax, problemData[problem]["solvedBy"])
        }
        for(var problem in problemData){
            if(problemData[problem]["contestId"] === lastContest && !(AC.has(problem)) && !(snoozed.has(problem))){
                upsolve.push({
                    contestId : lastContest,
                    index : problemData[problem]["index"],
                    name : problemData[problem]["name"],
                    tags : problemData[problem]["tags"],
                    solvedBy : problemData[problem]["solvedBy"],
                    solved : false,
                    practiceTime : 60
                })
                continue
            }
            if(problemData[problem]["rating"] < low || problemData[problem]["rating"] > high)  continue
            if(AC.has(problem) || snoozed.has(problem))   continue
            let score = (100 - (Math.abs(userRating - problemData[problem]["rating"])/userRating))
            let tagScore = 0, tagCount = 0
            problemData[problem]["tags"].forEach(tag => {
                tagScore += tagSlabs[userSlabIndex].findIndex(_tag => _tag.name === tag);
                tagCount++;
            })
            if(tagCount)    score += 200 * tagScore / (tagCount * tagSlabs[userSlabIndex].length)
            score += 300 * problemData[problem]["solvedBy"] / subMax
            const problemObject = {
                contestId : problemData[problem]["contestId"],
                index : problemData[problem]["index"],
                score : Math.floor((score/6)*100)/100,
                name : problemData[problem]["name"],
                rating : problemData[problem]["rating"],
                tags : problemData[problem]["tags"],
                solvedBy : problemData[problem]["solvedBy"],
                solved : false,
            }
            if(problemData[problem]["rating"] < userRating - 100 && problemData[problem]["solvedBy"] > solvability*2 && problemData[problem]["solvedBy"] < solvability*4){
                problemObject["practiceTime"] = 30
                if(touched.has(problemData[problem]["contestId"]))  past.easy.push(problemObject)
                else easy.push(problemObject)
            }
            else if(problemData[problem]["rating"] > userRating + 200 && problemData[problem]["solvedBy"] < solvability/2){
                problemObject["practiceTime"] = 60
                if(touched.has(problemData[problem]["contestId"]))  past.hard.push(problemObject)
                else hard.push(problemObject)
            }
            else if(problemData[problem]["solvedBy"] <= solvability*2  && problemData[problem]["solvedBy"] >= solvability/2 && problemData[problem]["rating"] >= userRating - 100 && problemData[problem]["rating"] <= userRating + 200){
                problemObject["practiceTime"] = 45
                if(touched.has(problemData[problem]["contestId"]))  past.medium.push(problemObject)
                else medium.push(problemObject)
            }
        }
        returnObject.problemData.easy = easy.sort((a, b) => b.score - a.score).slice(0, Math.min(Math.max(0, counts.easy), easy.length))
        returnObject.problemData.medium = medium.sort((a, b) => b.score - a.score).slice(0, Math.min(Math.max(0, counts.medium), medium.length))
        returnObject.problemData.hard = hard.sort((a, b) => b.score - a.score).slice(0, Math.min(Math.max(0, counts.hard), hard.length))
        returnObject.problemData.upsolve = upsolve.sort((a, b) => a["solvedBy"] < b["solvedBy"])
        returnObject.problemData.past = {}
        for(var key in past)    returnObject.problemData.past[key] = past[key].sort((a, b) => b.score - a.score).slice(0, Math.min(past[key].length, 3))
        response.json(returnObject)
    }
    
    const getUserData = () => {
        request(`https://codeforces.com/api/user.info?handles=${handle}`, (error, res ,body) => {
            const data = JSON.parse(res.body)
            if(data["status"] !== "OK"){
                response.json({"errorMessage": "Invalid User Handle"})
                return;
            }
            User.find({handle}).then(result => {
                if(result.length === 0) newUser = true
                else    dbUser = result[0]
            })
            const user = data["result"][0]
            userRating = user["maxRating"]
            if(userRating === undefined)    userRating = 1000;
            userSlabIndex = userSlab(userRating)
            returnObject.userHandle = handle
            returnObject.userRating = userRating
            returnObject.userFName = user["firstName"]
            returnObject.userLName = user["lastName"]
            returnObject.userRank = user["rank"]
            returnObject.userPic = user["avatar"]
            returnObject.userOrg = user["organization"]
            getStatus()
        })
        const getStatus = () => {
            request(`https://codeforces.com/api/user.status?handle=${handle}`, (error, res, body) => {
                try{
                    const data = JSON.parse(res.body)
                    if(data["status"] !== "OK"){
                        response.json({"errorMessage": "Invalid User Handle"})
                        return;
                    }
                    dbUser.data.AC.forEach(prob => AC.add(prob))
                    dbUser.data.snoozed.forEach(prob => snoozed.add(prob))
                    data["result"].forEach(submission => {
                        const pid = submission["problem"]["contestId"] + submission["problem"]["index"]
                        if(submission["verdict"] === "OK"){
                            if(problemData[pid] === undefined)  return // Div 2 C => Div 1 A
                            AC.add(pid)
                            solvability += problemData[pid]["solvedBy"] * problemData[pid]["rating"] / 4000
                        }
                        touched.add(submission["problem"]["contestId"])
                    })
                    if(AC.size !== 0)   solvability /= AC.size
                    dbUser.data.lastSubID = Math.max(dbUser.data.lastSubID, data["result"][0]["id"])
                    dbUser.data.AC = []
                    AC.forEach(prob => dbUser.data.AC.push(prob))
                    if(newUser){
                        const newDBUser = new User(dbUser)
                        newDBUser.save().then(() => console.log("User Added:", dbUser.handle))
                    }
                    else    User.findByIdAndUpdate(dbUser._id, dbUser, { new : true })
                }
                catch(err){
                    console.log(err)
                    response.json({errorMessage: "Some error occurred! Please try again later!"})
                }
                finally{
                    getLast()
                }
            })
        }

        const getLast = () => {
            request(`https://codeforces.com/api/user.rating?handle=${handle}`, (err, res, body) => {
                try{
                    const data = JSON.parse(res.body)
                    if(data["status"] === "OK" && data["result"].length)    lastContest = data["result"][data["result"].length - 1]["contestId"]
                }
                catch(err){
                    console.log(err)
                    response.json({errorMessage: "Some error occurred! Please try again later!"})
                }
                finally{
                    getSuggestion()
                }
            })
        }
    }

    getUserData()
}

const verifySubmission = (handle, cid, index, response) => {
    request(`https://codeforces.com/api/user.status?handle=${handle}&from=1&count=1000`, (err, res, body) => {
        const data = JSON.parse(res.body)
        if(data["status"] !== "OK"){
            response.json({"errorMessage": "Some error occurred. Please try again!"})
            return
        }
        let found = false
        data["result"].forEach(submission => {
            if(submission["problem"]["contestId"] === cid && submission["problem"]["index"] === index && submission["verdict"] === "OK"){
                found = true
            }
        })
        response.json({verified : found})
    })
}

const skipQuestion = (handle, pid, response) => {
    try{
        User.find({handle}).then(result => {
            const dbUser = result[0]
            dbUser.data.AC.push(pid)
            User.findByIdAndUpdate(dbUser._id, dbUser, { new : true }).then(newDBUser => {
                console.log("User updated:", newDBUser.handle)
                response.json({skipped: true})
            })
        })
    }
    catch(err){
        response.json({errorMessage: "Some error occurred! Please try again later!"})
    }
}

const getIndex = (usidx, tag) => {
    var index = 0
    tagSlabs[usidx].forEach((_tag, idx) => {
        if(_tag.name === tag)   index = idx+1
    })
    return index
}

app.get('/suggest/:handle/:easy/:medium/:hard/:low?/:high?', (request, response) => {
    if(isCFdown){
        response.json({errorMessage: "Codeforces seems to be down at the moment!"})
        return response.end()
    }
    const handle = request.params.handle
    const counts = {
        easy : Number(request.params.easy),
        medium : Number(request.params.medium),
        hard : Number(request.params.hard),
    }
    setTimeout(() => processRequest(handle, counts, response, request.params.low, request.params.high), 100 * (Object.keys(problemData).length === 0))
})

app.get('/verify/:handle/:contestId/:index', (request, response) => {
    if(isCFdown){
        response.json({errorMessage: "Codeforces seems to be down at the moment!"})
        return response.end()
    }
    const handle = request.params.handle
    const cid = Number(request.params.contestId)
    const index = request.params.index
    verifySubmission(handle, cid, index, response)
})

app.get('/skip/:handle/:pid', (request, response) => {
    skipQuestion(request.params.handle, request.params.pid, response)
})

app.get('/later/:handle/:pid', (request, response) => {
    try{
        User.find({handle: request.params.handle}).then(result => {
            const dbUser = result[0]
            dbUser.data.snoozed.push(request.params.pid)
            User.findByIdAndUpdate(dbUser._id, dbUser, { new : true }).then(newDBUser => {
                console.log("User updated:", newDBUser.handle)
                response.json({saved: true})
            })
            setTimeout(() => {
                User.find({handle: dbUser.handle}).then(result => {
                    const newDBUser = result[0]
                    newDBUser.data.snoozed = newDBUser.data.snoozed.filter(prob => prob !== request.params.pid)
                    User.findByIdAndUpdate(newDBUser._id, newDBUser, { new : true }).then(remSnooze => console.log("User updated:", remSnooze.handle))
                })
            }, 2 * 24 * 3600 * 1000)
        })
    }
    catch(err){
        response.json({errorMessage: "Some error occurred! Please try again later!"})
    }
})

app.get('/usercount', (request, response) => {
    response.json({count: usercount})
})

app.get('/swot/:handle', (req, response) => {
    if(isCFdown){
        response.json({errorMessage: "Codeforces seems to be down at the moment!"})
        return response.end()
    }
    const handle = req.params.handle
    var usidx = 0
    var returnObject = {}
    request(`https://codeforces.com/api/user.info?handles=${handle}`, (err, res, body) => {
        try{
            const data = JSON.parse(res.body)
            if(data["status"] !== "OK"){
                response.json({"errorMessage": "Invalid User Handle"})
                return;
            }
            const user = data["result"][0]
            returnObject.userRating = user["maxRating"]
            returnObject.userHandle = user["handle"]
            usidx = userSlab(user["maxRating"])
        }
        catch(err){
            response.json({errorMessage: "Some Error occurred! Please try again later."})
        }
        finally{
            proceed()
        }
    })
    const proceed = () => {
        request(`https://codeforces.com/api/user.status?handle=${handle}`, (err, res, body) => {
            try{
                const data = JSON.parse(res.body)
                var tagMap = new Map()
                var countMap = new Map()
                data["result"].forEach(submission => {
                    if(submission["verdict"] === "SKIPPED") return
                    const pid = submission["problem"]["contestId"] + submission["problem"]["index"]
                    if(problemData[pid] === undefined)  return
                    submission["problem"]["tags"].forEach(_tag => {
                        let cv = 0, cc = 0
                        if(tagMap.has(_tag))    cv = tagMap.get(_tag), cc = countMap.get(_tag)
                        tagMap.set(_tag, cv + (submission["verdict"] === "OK"?1:-0.2) * problemData[pid]["rating"] / problemData[pid]["solvedBy"] * problemData[pid]["rating"] / 100 * getIndex(usidx, _tag))
                        countMap.set(_tag, cc + (submission["verdict"] === "OK" ? 1 : 0))
                    })
                })
                var returnArray = []
                tagMap.forEach((value, key) => returnArray.push({tag: key, points: value, count: countMap.get(key)}))
                returnArray.sort((a, b) => a["points"] - b["points"])
                response.json({
                    ...returnObject,
                    swot : returnArray,
                    slab : tagSlabs[usidx].filter(tag => tag.count > 50),
                })
            }
            catch(err){
                response.json({errorMessage: "Some Error occurred! Please try again later."})
            }
            finally{
                User.find({handle}).then(result => {
                    if(result.length === 0){
                        var dbUser = {
                            handle,
                            data : {
                                AC : [],
                                snoozed : [],
                                lastSubID : 0
                            }
                        }
                        const newDBUser = new User(dbUser)
                        newDBUser.save().then(() => console.log("User Added:", dbUser.handle))
                    }
                })
            }
        })
    }
})

app.listen(PORT, () => {
    console.log("Server started!");
    getCFData();
    checkCFdown();
    updateUC();
    setInterval(getCFData, 3600*1000);
    setInterval(checkCFdown, 60*1000);
    setInterval(updateUC, 60*1000);
})