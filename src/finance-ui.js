/* Owner-only financial snapshot UI. No localStorage, transactions or broker orders. */
(() => {
  let generation = 0;
  let controller = null;

  const make = (tag, className='', value=null) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== null) node.textContent = String(value);
    return node;
  };
  const add = (parent, ...nodes) => { for (const node of nodes) parent.append(node); return parent; };
  const labelValue = (parent, label, value) => add(parent,
    make('span','finance-label',label), make('strong','finance-value',value));

  function sourceNote(source) {
    switch (source) {
      case 'available': return 'Provider data received';
      case 'not_configured': return 'Not connected - read-only access has not been configured';
      case 'live_access_not_authorized': return 'Live brokerage access is disabled';
      default: return 'Source unavailable - no balance shown';
    }
  }
  function accountCard(account) {
    const article = make('article','finance-account');
    add(article,make('h3','finance-account-title',account.label),
      make('p','finance-meta',account.kind+' / '+account.status));
    const row = make('div','finance-numbers');
    const current=make('div','finance-amount');labelValue(current,'Current balance',financeDisplayMoney(account.currentCents));
    const available=make('div','finance-amount');labelValue(available,'Available balance',financeDisplayMoney(account.availableCents));
    add(row,current,available);article.append(row);
    return article;
  }
  function bankPanel(source) {
    const panel=make('section','panel finance-panel');panel.setAttribute('aria-labelledby','finance-mercury-title');
    const head=make('div','panel-head');const title=make('h2','', 'Mercury banking');title.id='finance-mercury-title';
    add(head,title,make('span','tag','BANK / READ ONLY'));panel.append(head);
    panel.append(make('p','finance-source-note',sourceNote(source.status)));
    if(source.status==='available'){
      if(source.accounts.length===0)panel.append(make('p','finance-empty','No owned Mercury accounts were returned.'));
      else source.accounts.forEach(account=>panel.append(accountCard(account)));
    }
    panel.append(make('p','tiny muted finance-disclaimer','Bank balances are real account observations, not trading profits. Pending transactions may change available cash.'));
    return panel;
  }
  function brokerPanel(source) {
    const panel=make('section','panel finance-panel');panel.setAttribute('aria-labelledby','finance-alpaca-title');
    const head=make('div','panel-head');const title=make('h2','', 'Alpaca research');title.id='finance-alpaca-title';
    add(head,title,make('span','tag','PAPER / SIMULATED'));panel.append(head);
    panel.append(make('p','finance-source-note',sourceNote(source.status)));
    if(source.status==='available'){
      const account=source.account;
      panel.append(make('p','finance-meta','Paper account: '+account.accountStatus));
      const values=make('div','finance-broker-metrics');
      for(const [title,value] of [
        ['Paper equity',financeDisplayMoney(account.equityCents)],
        ['Paper cash',financeDisplayMoney(account.cashCents)],
        ['Paper buying power',financeDisplayMoney(account.buyingPowerCents)],
        ['Open paper positions',String(account.positionsCount)],
      ]){const item=make('div','finance-broker-metric');labelValue(item,title,value);values.append(item);}
      panel.append(values);
    }
    panel.append(make('p','tiny muted finance-disclaimer','Paper balances are simulated. They are not bank funds, available cash for household spending, or live investment performance.'));
    return panel;
  }
  function researchPanel() {
    const panel=make('section','panel finance-research');panel.setAttribute('aria-labelledby','finance-tpd-title');
    const head=make('div','panel-head');const title=make('h2','', 'TPD% - Trading Percentage Daily');title.id='finance-tpd-title';
    add(head,title,make('span','tag','RECONCILIATION REQUIRED'));panel.append(head);
    panel.append(make('p','finance-tpd-value','Not available'));
    panel.append(make('p','tiny muted','Cash-flow-adjusted brokerage returns remain unavailable until complete dated equity and transfer evidence is reconciled. A daily target is not a promise or bank yield.'));
    return panel;
  }
  function securityPanel() {
    const panel=make('section','panel finance-safety');panel.setAttribute('aria-labelledby','finance-safety-title');
    const title=make('h2','','Execution remains disabled');title.id='finance-safety-title';panel.append(title);
    panel.append(make('p','tiny muted','No payments, transfers, orders, automated allocations, live trading, or combined net-worth calculation are available from this screen.'));
    return panel;
  }
  function showData(root, data) {
    const body=root.querySelector('#finance-results');
    const grid=make('div','finance-grid');
    add(grid,bankPanel(data.mercury),brokerPanel(data.alpaca));
    body.replaceChildren(grid,researchPanel(),securityPanel());
    root.querySelector('#finance-updated').textContent='Observed '+new Date(data.fetchedAt).toLocaleString();
    root.querySelector('#finance-message').textContent='Read-only provider snapshot loaded. No financial operation was executed.';
  }
  function showProblem(root, reason) {
    root.querySelector('#finance-results').replaceChildren();
    root.querySelector('#finance-updated').textContent='Not verified';
    root.querySelector('#finance-message').textContent=reason;
  }
  async function refresh(root) {
    if(controller)controller.abort();
    const current=++generation;controller=new AbortController();
    const signal=controller.signal,button=root.querySelector('#finance-refresh');
    button.disabled=true;
    // Do not display previously observed balances as current while a new
    // authenticated observation is pending or may fail authorization.
    root.querySelector('#finance-results').replaceChildren();
    root.querySelector('#finance-updated').textContent='Not verified';
    root.querySelector('#finance-message').textContent='Retrieving private read-only sources...';
    try {
      const response=await fetch('/api/finance/summary',{
        method:'GET',credentials:'same-origin',redirect:'manual',cache:'no-store',
        headers:{Accept:'application/json','X-Requested-With':'XMLHttpRequest'},signal,
      });
      if(signal.aborted||current!==generation||!root.isConnected)return;
      if([401,403].includes(response.status)||response.type==='opaqueredirect'||response.status>=300&&response.status<400){
        showProblem(root,'Sign-in or owner authorization is required. No financial data was loaded.');return;
      }
      if(!response.ok||!response.headers.get('Content-Type')?.toLowerCase().includes('application/json')){
        showProblem(root,'Financial sources could not be verified. No balances are displayed.');return;
      }
      const raw=await response.json();
      if(signal.aborted||current!==generation||!root.isConnected)return;
      let clean;
      try{clean=financeNormalizeSnapshot(raw)}
      catch{showProblem(root,'Financial source data failed safety validation. No balances are displayed.');return;}
      showData(root,clean);
    } catch(error) {
      if(signal.aborted||current!==generation||!root.isConnected)return;
      // Never render upstream errors or private URLs into the interface.
      showProblem(root,'The private financial connection is unavailable. No balances are displayed.');
    } finally {
      if(current===generation){button.disabled=false;controller=null;}
    }
  }
  function mounted(section) {
    if(section!=='finance'){
      if(controller)controller.abort();
      controller=null;generation++;
      return;
    }
    const root=document.querySelector('#station-finance');
    if(!root||root.dataset.financeMounted==='true')return;
    root.dataset.financeMounted='true';
    root.replaceChildren();
    const toolbar=make('div','finance-toolbar');
    const status=make('div','finance-toolbar-status');
    const updated=make('span','finance-updated','Not verified');updated.id='finance-updated';
    const message=make('p','tiny muted','Read-only sources are not loaded.');message.id='finance-message';
    message.setAttribute('role','status');message.setAttribute('aria-live','polite');
    add(status,updated,message);
    const button=make('button','primary','Refresh read-only data');button.id='finance-refresh';button.type='button';
    button.addEventListener('click',()=>refresh(root));
    add(toolbar,status,button);
    const results=make('div','finance-results');results.id='finance-results';
    add(root,toolbar,results);
    refresh(root);
  }
  globalThis.StationFinance={mounted};
})();
